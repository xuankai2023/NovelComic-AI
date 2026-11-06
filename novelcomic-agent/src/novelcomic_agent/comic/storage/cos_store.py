"""Tencent COS object store. Success is recorded only after checksum promotion."""

from __future__ import annotations

import asyncio
import hashlib
import re
import sys
from typing import Protocol
from uuid import uuid4

from qcloud_cos import CosConfig, CosS3Client, CosServiceError

from novelcomic_agent.config import Settings

from .object_store import _reject_unsafe_key

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_SHA_HEADER = "x-cos-meta-sha256"


class _CosTransport(Protocol):
    def put_object(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str,
        sha256: str,
    ) -> None:
        """Upload bytes to an object key."""

    def head_object(self, key: str) -> dict[str, str] | None:
        """Return response headers, or None when the key is absent."""

    def get_object(self, key: str) -> bytes:
        """Download an object. Missing keys raise KeyError."""

    def copy_object(self, source_key: str, dest_key: str) -> None:
        """Copy an object onto another key in the same bucket."""

    def delete_object(self, key: str) -> None:
        """Delete an object. Missing keys are a no-op."""

    def presign(self, key: str, *, expires_in: int) -> str:
        """Mint an HTTPS read URL that expires."""


class CosObjectStore:
    """COS store with the same temp, checksum, and promote order as memory."""

    def __init__(self, *, cdn_domain: str, transport: _CosTransport) -> None:
        self._cdn_base = _https_base(cdn_domain)
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> CosObjectStore:
        required = {
            "COS_SECRET_ID": settings.cos_secret_id,
            "COS_SECRET_KEY": settings.cos_secret_key,
            "COS_REGION": settings.cos_region,
            "COS_BUCKET": settings.cos_bucket,
            "COS_CDN_DOMAIN": settings.cos_cdn_domain,
        }
        missing = [name for name, value in required.items() if not value or not value.strip()]
        if missing:
            raise ValueError("COS environment variables are missing: " + ", ".join(missing))
        _https_base(settings.cos_cdn_domain)
        transport = QcloudCosClient(
            secret_id=settings.cos_secret_id.strip(),
            secret_key=settings.cos_secret_key.strip(),
            region=settings.cos_region.strip(),
            bucket=settings.cos_bucket.strip(),
        )
        return cls(cdn_domain=settings.cos_cdn_domain, transport=transport)

    def stable_url(self, key: str) -> str:
        _reject_unsafe_key(key)
        return f"{self._cdn_base}/{key}"

    async def put_verified(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        _reject_unsafe_key(key)
        digest = hashlib.sha256(body).hexdigest()
        temp_key = f"_tmp/{digest}/{uuid4().hex}"
        try:
            await self._call(
                self._transport.put_object,
                temp_key,
                body,
                content_type=content_type,
                sha256=digest,
            )
            staged = await self._download_digest(temp_key)
            if staged != digest:
                raise ValueError("temp object checksum mismatch")
            existing = await self.checksum(key)
            if existing is not None:
                if existing != digest:
                    raise ValueError("object key already holds different bytes")
                return digest
            await self._call(self._transport.copy_object, temp_key, key)
            promoted = await self._download_digest(key)
            if promoted != digest:
                await self.delete(key)
                raise ValueError("promoted object checksum mismatch")
            return digest
        finally:
            pending = sys.exception()
            try:
                await self.delete(temp_key)
            except Exception:
                if pending is None:
                    raise

    async def head(self, key: str) -> int | None:
        headers = await self._call(self._transport.head_object, key)
        if headers is None:
            return None
        length = _header(headers, "content-length")
        if length is None:
            return len(await self.get(key))
        return int(length)

    async def checksum(self, key: str) -> str | None:
        headers = await self._call(self._transport.head_object, key)
        if headers is None:
            return None
        meta = _header(headers, _SHA_HEADER)
        if meta is not None and _SHA256.fullmatch(meta.lower()):
            return meta.lower()
        return await self._download_digest(key)

    async def get(self, key: str) -> bytes:
        return await self._call(self._transport.get_object, key)

    async def signed_url(self, key: str, *, expires_in: int = 900) -> str:
        if isinstance(expires_in, bool) or not isinstance(expires_in, int) or expires_in <= 0:
            raise ValueError("expires_in must be positive")
        _reject_unsafe_key(key)
        if await self.head(key) is None:
            raise KeyError(key)
        return await self._call(self._transport.presign, key, expires_in=expires_in)

    async def copy(self, source_key: str, dest_key: str) -> None:
        body = await self.get(source_key)
        await self.put_verified(dest_key, body)

    async def delete(self, key: str) -> None:
        await self._call(self._transport.delete_object, key)

    async def aclose(self) -> None:
        closer = getattr(self._transport, "close", None)
        if closer is not None:
            await self._call(closer)

    async def _download_digest(self, key: str) -> str | None:
        try:
            body = await self.get(key)
        except KeyError:
            return None
        return hashlib.sha256(body).hexdigest()

    async def _call(self, func, *args, **kwargs):
        return await asyncio.to_thread(func, *args, **kwargs)


class QcloudCosClient:
    """Sync COS SDK calls. CosObjectStore runs them on a worker thread."""

    def __init__(
        self,
        *,
        secret_id: str,
        secret_key: str,
        region: str,
        bucket: str,
        sdk=None,
    ) -> None:
        self.bucket = bucket
        self.region = region
        if sdk is None:
            sdk = CosS3Client(
                CosConfig(
                    Region=region,
                    SecretId=secret_id,
                    SecretKey=secret_key,
                    Scheme="https",
                )
            )
        self._sdk = sdk

    def put_object(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str,
        sha256: str,
    ) -> None:
        self._sdk.put_object(
            Bucket=self.bucket,
            Body=body,
            Key=key,
            ContentType=content_type,
            CacheControl="public, max-age=31536000",
            Metadata={_SHA_HEADER: sha256},
        )

    def head_object(self, key: str) -> dict[str, str] | None:
        try:
            headers = self._sdk.head_object(Bucket=self.bucket, Key=key)
        except CosServiceError as exc:
            if _is_missing(exc):
                return None
            raise
        normalized: dict[str, str] = {}
        for name, value in headers.items():
            text = value.decode("utf-8") if isinstance(value, bytes) else str(value)
            normalized[str(name).lower()] = text
        return normalized

    def get_object(self, key: str) -> bytes:
        try:
            response = self._sdk.get_object(Bucket=self.bucket, Key=key)
        except CosServiceError as exc:
            if _is_missing(exc):
                raise KeyError(key) from exc
            raise
        body = response["Body"]
        try:
            chunks: list[bytes] = []
            while True:
                chunk = body.read(1024 * 1024, auto_decompress=True)
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            closer = getattr(body, "_rt", None)
            if closer is not None:
                closer.close()

    def copy_object(self, source_key: str, dest_key: str) -> None:
        self._sdk.copy_object(
            Bucket=self.bucket,
            Key=dest_key,
            CopySource={"Bucket": self.bucket, "Key": source_key, "Region": self.region},
        )

    def delete_object(self, key: str) -> None:
        try:
            self._sdk.delete_object(Bucket=self.bucket, Key=key)
        except CosServiceError as exc:
            if _is_missing(exc):
                return
            raise

    def close(self) -> None:
        if getattr(self._sdk, "_use_built_in_pool", True):
            return
        session = getattr(self._sdk, "_session", None)
        close_session = getattr(session, "close", None)
        if close_session is not None:
            close_session()

    def presign(self, key: str, *, expires_in: int) -> str:
        url = self._sdk.get_presigned_url(
            Method="GET",
            Bucket=self.bucket,
            Key=key,
            Expired=expires_in,
        )
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ValueError("COS signed url must be https")
        return url


def _https_base(cdn_domain: str) -> str:
    value = cdn_domain.strip().rstrip("/")
    if not value:
        raise ValueError("COS_CDN_DOMAIN must be an https host")
    if "://" in value:
        scheme, rest = value.split("://", 1)
        if scheme.lower() != "https" or not rest or "/" in rest or "?" in rest:
            raise ValueError("COS_CDN_DOMAIN must be an https host")
        return f"https://{rest}"
    if "/" in value or "?" in value:
        raise ValueError("COS_CDN_DOMAIN must be an https host")
    return f"https://{value}"


def _header(headers: dict[str, str], name: str) -> str | None:
    value = headers.get(name.lower())
    if value is None:
        return None
    text = value.strip()
    return text or None


def _is_missing(exc: BaseException) -> bool:
    status = getattr(exc, "get_status_code", None)
    if status is not None and str(status()) == "404":
        return True
    error_code = getattr(exc, "get_error_code", None)
    if error_code is None:
        return False
    return error_code() in {"NoSuchKey", "NoSuchResource"}
