"""COS object promotion, stable URLs, and the Qcloud adapter."""

from __future__ import annotations

import hashlib
import threading

import pytest
from qcloud_cos import CosServiceError

from novelcomic_agent.comic.storage.cos_store import CosObjectStore, QcloudCosClient
from novelcomic_agent.config import Settings

KEY = "tenant-a/prod_1/source/page"
BODY = b"page"
DIGEST = hashlib.sha256(BODY).hexdigest()


class FakeCos:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.meta: dict[str, str] = {}
        self.types: dict[str, str] = {}
        self.copies: list[tuple[str, str]] = []
        self.downloads: list[str] = []
        self.presign_calls = 0
        self.corrupt_temp = False
        self.corrupt_promoted = False
        self.fail_temp_delete = False
        self._loop_thread = threading.current_thread()

    def _off_loop(self) -> None:
        if threading.current_thread() is self._loop_thread:
            raise AssertionError("COS SDK call ran on the event loop thread")

    def put_object(self, key: str, body: bytes, *, content_type: str, sha256: str) -> None:
        self._off_loop()
        self.objects[key] = body
        self.meta[key] = sha256
        self.types[key] = content_type

    def head_object(self, key: str) -> dict[str, str] | None:
        self._off_loop()
        if key not in self.objects:
            return None
        headers = {"content-length": str(len(self.objects[key]))}
        if self.meta.get(key):
            headers["x-cos-meta-sha256"] = self.meta[key]
        return headers

    def get_object(self, key: str) -> bytes:
        self._off_loop()
        if key not in self.objects:
            raise KeyError(key)
        self.downloads.append(key)
        if self.corrupt_temp and key.startswith("_tmp/"):
            return b"corrupt"
        if self.corrupt_promoted and not key.startswith("_tmp/"):
            return b"corrupt"
        return self.objects[key]

    def copy_object(self, source_key: str, dest_key: str) -> None:
        self._off_loop()
        self.objects[dest_key] = self.objects[source_key]
        self.meta[dest_key] = self.meta[source_key]
        self.types[dest_key] = self.types[source_key]
        self.copies.append((source_key, dest_key))

    def delete_object(self, key: str) -> None:
        self._off_loop()
        if self.fail_temp_delete and key.startswith("_tmp/"):
            raise RuntimeError("temp delete failed")
        self.objects.pop(key, None)
        self.meta.pop(key, None)
        self.types.pop(key, None)

    def presign(self, key: str, *, expires_in: int) -> str:
        self._off_loop()
        self.presign_calls += 1
        return (
            f"https://bucket.cos.ap-hongkong.myqcloud.com/{key}"
            f"?q-signature=abc&q-sign-time=1%3B{expires_in}"
        )


def _store(fake: FakeCos, *, cdn_domain: str = "cdn.example.com") -> CosObjectStore:
    return CosObjectStore(cdn_domain=cdn_domain, transport=fake)


def _promoted_keys(fake: FakeCos) -> list[str]:
    return [key for key in fake.objects if not key.startswith("_tmp/")]


async def test_same_bytes_are_idempotent_and_different_bytes_fail() -> None:
    fake = FakeCos()
    store = _store(fake)
    first = await store.put_verified(KEY, BODY, content_type="image/png")
    assert first == DIGEST
    assert await store.get(KEY) == BODY
    assert fake.types[KEY] == "image/png"
    assert len(fake.copies) == 1
    assert not any(key.startswith("_tmp/") for key in fake.objects)
    assert any(key.startswith("_tmp/") for key in fake.downloads)

    assert await store.put_verified(KEY, BODY, content_type="image/png") == DIGEST
    assert len(fake.copies) == 1
    assert await store.get(KEY) == BODY

    with pytest.raises(ValueError, match="different bytes"):
        await store.put_verified(KEY, b"other")
    assert await store.get(KEY) == BODY
    assert _promoted_keys(fake) == [KEY]


async def test_checksum_failure_does_not_leave_the_official_key() -> None:
    fake = FakeCos()
    store = _store(fake)
    fake.corrupt_temp = True
    with pytest.raises(ValueError, match="temp object checksum mismatch"):
        await store.put_verified(KEY, BODY)
    assert fake.copies == []
    assert _promoted_keys(fake) == []
    assert not any(key.startswith("_tmp/") for key in fake.objects)

    fake = FakeCos()
    store = _store(fake)
    fake.corrupt_promoted = True
    with pytest.raises(ValueError, match="promoted object checksum mismatch"):
        await store.put_verified(KEY, BODY)
    assert len(fake.copies) == 1
    assert _promoted_keys(fake) == []
    assert not any(key.startswith("_tmp/") for key in fake.objects)


async def test_temp_delete_failure_keeps_the_checksum_error() -> None:
    fake = FakeCos()
    store = _store(fake)
    fake.corrupt_temp = True
    fake.fail_temp_delete = True
    with pytest.raises(ValueError, match="temp object checksum mismatch"):
        await store.put_verified(KEY, BODY)
    assert KEY not in fake.objects


async def test_stable_url_is_stored_and_illegal_expiry_is_rejected() -> None:
    fake = FakeCos()
    store = _store(fake, cdn_domain="https://cdn.example.com/")
    assert store.stable_url(KEY) == f"https://cdn.example.com/{KEY}"
    digest = await store.put_verified(KEY, BODY)
    record = {"object_key": KEY, "sha256": digest, "url": store.stable_url(KEY)}
    signed = await store.signed_url(KEY, expires_in=900)
    assert record["url"] == f"https://cdn.example.com/{KEY}"
    assert "?" not in record["url"]
    for marker in ("expires=", "signature=", "x-amz-", "signed.", "q-signature"):
        assert marker not in record["url"]
    assert signed not in record.values()
    assert "q-signature=" in signed

    with pytest.raises(ValueError, match="expires_in must be positive"):
        await store.signed_url(KEY, expires_in=0)
    with pytest.raises(ValueError, match="expires_in must be positive"):
        await store.signed_url(KEY, expires_in=-30)
    assert fake.presign_calls == 1
    with pytest.raises(KeyError):
        await store.signed_url("tenant-a/prod_1/source/missing")
    assert fake.presign_calls == 1


async def test_unsafe_keys_are_rejected_before_upload() -> None:
    fake = FakeCos()
    store = _store(fake)
    for unsafe in ("", "../secret", "/absolute", "tenant/../../secret", "_tmp/hidden"):
        with pytest.raises(ValueError, match="unsafe object key"):
            await store.put_verified(unsafe, BODY)
        with pytest.raises(ValueError, match="unsafe object key"):
            store.stable_url(unsafe)
    assert fake.objects == {}
    with pytest.raises(ValueError, match="https"):
        CosObjectStore(cdn_domain="http://cdn.example.com", transport=fake)


async def test_head_delete_copy_and_metadata_fallback() -> None:
    fake = FakeCos()
    store = _store(fake)
    await store.put_verified(KEY, BODY)
    assert await store.head(KEY) == len(BODY)
    assert await store.checksum(KEY) == DIGEST
    assert fake.downloads.count(KEY) == 1

    copied = "tenant-a/prod_1/source/copy"
    await store.copy(KEY, copied)
    assert await store.get(copied) == BODY
    await store.delete(KEY)
    assert await store.head(KEY) is None
    await store.delete(KEY)

    bare = FakeCos()
    bare.objects[KEY] = BODY
    bare_store = _store(bare)
    assert await bare_store.checksum(KEY) == DIGEST
    assert bare.downloads == [KEY]


def test_settings_load_cos_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COS_SECRET_ID", "sid")
    monkeypatch.setenv("COS_SECRET_KEY", "skey")
    monkeypatch.setenv("COS_REGION", "ap-hongkong")
    monkeypatch.setenv("COS_BUCKET", "bucket-1")
    monkeypatch.setenv("COS_CDN_DOMAIN", "cdn.example.com")
    settings = Settings()
    assert settings.cos_secret_id == "sid"
    assert settings.cos_secret_key == "skey"
    assert settings.cos_region == "ap-hongkong"
    assert settings.cos_bucket == "bucket-1"
    assert settings.cos_cdn_domain == "cdn.example.com"


def test_from_settings_reports_missing_variables_and_builds_a_client() -> None:
    empty = Settings(
        cos_secret_id="",
        cos_secret_key="",
        cos_region="",
        cos_bucket="",
        cos_cdn_domain="",
    )
    with pytest.raises(
        ValueError,
        match="COS_SECRET_ID, COS_SECRET_KEY, COS_REGION, COS_BUCKET, COS_CDN_DOMAIN",
    ):
        CosObjectStore.from_settings(empty)

    missing_domain = Settings(
        cos_secret_id="sid",
        cos_secret_key="skey",
        cos_region="ap-hongkong",
        cos_bucket="bucket-1",
        cos_cdn_domain="   ",
    )
    with pytest.raises(ValueError, match="COS_CDN_DOMAIN"):
        CosObjectStore.from_settings(missing_domain)

    insecure = Settings(
        cos_secret_id="sid",
        cos_secret_key="skey",
        cos_region="ap-hongkong",
        cos_bucket="bucket-1",
        cos_cdn_domain="http://cdn.example.com",
    )
    with pytest.raises(ValueError, match="https"):
        CosObjectStore.from_settings(insecure)

    store = CosObjectStore.from_settings(
        Settings(
            cos_secret_id="sid",
            cos_secret_key="skey",
            cos_region="ap-hongkong",
            cos_bucket="bucket-1",
            cos_cdn_domain="https://cdn.example.com/",
        )
    )
    assert store.stable_url(KEY) == f"https://cdn.example.com/{KEY}"


class _Body:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.offset = 0
        self.closed = False
        self._rt = self

    def read(self, size: int, auto_decompress: bool = False) -> bytes:
        del auto_decompress
        chunk = self.payload[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True


class _Sdk:
    def __init__(self, *, status: int = 404) -> None:
        self.status = status
        self.put_kwargs: dict | None = None
        self.presign_kwargs: dict | None = None
        self.copied: dict | None = None
        self.body: _Body | None = None

    def head_object(self, **kwargs: object) -> dict[str, str]:
        del kwargs
        code = "NoSuchKey" if self.status == 404 else "InternalError"
        raise CosServiceError("HEAD", {"code": code, "message": "missing"}, self.status)

    def delete_object(self, **kwargs: object) -> dict[str, str]:
        del kwargs
        if self.status == 404:
            raise CosServiceError("DELETE", {"code": "NoSuchKey", "message": "missing"}, 404)
        return {}

    def get_object(self, **kwargs: object) -> dict[str, _Body]:
        del kwargs
        if self.status == 404:
            raise CosServiceError("GET", {"code": "NoSuchKey", "message": "missing"}, 404)
        self.body = _Body(BODY)
        return {"Body": self.body}

    def put_object(self, **kwargs: object) -> None:
        self.put_kwargs = kwargs

    def copy_object(self, **kwargs: object) -> None:
        self.copied = kwargs

    def get_presigned_url(self, **kwargs: object) -> str:
        self.presign_kwargs = kwargs
        return f"https://bucket-1.cos.ap-hongkong.myqcloud.com/{KEY}?q-signature=abc"


def test_qcloud_adapter_maps_sdk_calls() -> None:
    missing = _Sdk()
    client = QcloudCosClient(
        secret_id="sid",
        secret_key="skey",
        region="ap-hongkong",
        bucket="bucket-1",
        sdk=missing,
    )
    assert client.head_object(KEY) is None
    client.delete_object(KEY)
    with pytest.raises(KeyError):
        client.get_object(KEY)

    failed = _Sdk(status=500)
    failed_client = QcloudCosClient(
        secret_id="sid",
        secret_key="skey",
        region="ap-hongkong",
        bucket="bucket-1",
        sdk=failed,
    )
    with pytest.raises(CosServiceError):
        failed_client.head_object(KEY)

    ready = _Sdk(status=200)
    ready_client = QcloudCosClient(
        secret_id="sid",
        secret_key="skey",
        region="ap-hongkong",
        bucket="bucket-1",
        sdk=ready,
    )
    ready_client.put_object(KEY, BODY, content_type="image/png", sha256=DIGEST)
    assert ready.put_kwargs is not None
    assert ready.put_kwargs["Bucket"] == "bucket-1"
    assert ready.put_kwargs["Key"] == KEY
    assert ready.put_kwargs["Body"] == BODY
    assert ready.put_kwargs["ContentType"] == "image/png"
    assert ready.put_kwargs["Metadata"] == {"x-cos-meta-sha256": DIGEST}
    assert ready_client.get_object(KEY) == BODY
    assert ready.body is not None and ready.body.closed
    ready_client.copy_object(f"_tmp/{DIGEST}/abc", KEY)
    assert ready.copied is not None
    assert ready.copied["CopySource"] == {
        "Bucket": "bucket-1",
        "Key": f"_tmp/{DIGEST}/abc",
        "Region": "ap-hongkong",
    }
    signed = ready_client.presign(KEY, expires_in=900)
    assert signed.startswith("https://")
    assert "q-signature=" in signed
    assert ready.presign_kwargs == {
        "Method": "GET",
        "Bucket": "bucket-1",
        "Key": KEY,
        "Expired": 900,
    }
