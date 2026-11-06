"""Object store boundary. Success is recorded only after checksum promotion."""

from __future__ import annotations

import hashlib
from typing import Protocol
from uuid import uuid4


class ObjectStore(Protocol):
    def stable_url(self, key: str) -> str:
        """Return the durable URL stored in the database, never a signed URL."""

    async def put_verified(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Write a temp object, verify its checksum, then promote it."""

    async def head(self, key: str) -> int | None:
        """Return the object size, or None when the key is absent."""

    async def checksum(self, key: str) -> str | None:
        """Return the sha256 digest of a promoted object."""

    async def get(self, key: str) -> bytes:
        """Read a promoted object."""

    async def signed_url(self, key: str, *, expires_in: int = 900) -> str:
        """Mint a short-lived read URL. Callers must not persist it."""

    async def copy(self, source_key: str, dest_key: str) -> None:
        """Copy a promoted object onto another key."""

    async def delete(self, key: str) -> None:
        """Delete an object. Missing keys are a no-op."""


class MemoryObjectStore:
    """Process-local store that enforces temp → checksum → promote."""

    def __init__(self, *, public_base: str = "https://objects.novelcomic.local") -> None:
        self._objects: dict[str, bytes] = {}
        self._public_base = public_base.rstrip("/")

    def stable_url(self, key: str) -> str:
        _reject_unsafe_key(key)
        return f"{self._public_base}/{key}"

    async def put_verified(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> str:
        del content_type
        _reject_unsafe_key(key)
        digest = hashlib.sha256(body).hexdigest()
        temp_key = f"_tmp/{digest}/{uuid4().hex}"
        self._objects[temp_key] = body
        try:
            staged = await self.checksum(temp_key)
            if staged != digest:
                raise ValueError("temp object checksum mismatch")
            existing = self._objects.get(key)
            if existing is not None:
                if hashlib.sha256(existing).hexdigest() != digest:
                    raise ValueError("object key already holds different bytes")
                return digest
            self._objects[key] = body
            promoted = await self.checksum(key)
            if promoted != digest:
                self._objects.pop(key, None)
                raise ValueError("promoted object checksum mismatch")
            return digest
        finally:
            self._objects.pop(temp_key, None)

    async def head(self, key: str) -> int | None:
        body = self._objects.get(key)
        if body is None:
            return None
        return len(body)

    async def checksum(self, key: str) -> str | None:
        body = self._objects.get(key)
        if body is None:
            return None
        return hashlib.sha256(body).hexdigest()

    async def get(self, key: str) -> bytes:
        body = self._objects.get(key)
        if body is None:
            raise KeyError(key)
        return body

    async def signed_url(self, key: str, *, expires_in: int = 900) -> str:
        if key not in self._objects:
            raise KeyError(key)
        if expires_in <= 0:
            raise ValueError("expires_in must be positive")
        return f"https://signed.novelcomic.local/{key}?expires={expires_in}"

    async def copy(self, source_key: str, dest_key: str) -> None:
        body = await self.get(source_key)
        await self.put_verified(dest_key, body)

    async def delete(self, key: str) -> None:
        self._objects.pop(key, None)


def _reject_unsafe_key(key: str) -> None:
    if not key or key.startswith("/") or "\\" in key or ".." in key or key.startswith("_tmp/"):
        raise ValueError("unsafe object key")
