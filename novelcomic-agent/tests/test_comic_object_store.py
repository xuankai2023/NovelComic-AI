"""Object keys and checksum promotion."""

from __future__ import annotations

import hashlib

import pytest

from novelcomic_agent.comic.storage.key_layout import source_object_key
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore

CHECKSUM = hashlib.sha256(b"page").hexdigest()


def test_unsafe_names_and_checksums_are_rejected() -> None:
    with pytest.raises(ValueError):
        source_object_key(
            tenant_id="..",
            production_id="prod_1",
            page_id="a" * 64,
            checksum=CHECKSUM,
        )
    with pytest.raises(ValueError):
        source_object_key(
            tenant_id="tenant-a",
            production_id="prod_1",
            page_id="a" * 64,
            checksum="not-a-checksum",
        )
    key = source_object_key(
        tenant_id="tenant-a",
        production_id="prod_1",
        page_id="a" * 64,
        checksum=CHECKSUM,
    )
    assert key.startswith("tenant-a/prod_1/source/")


async def test_temp_object_is_promoted_only_after_checksum() -> None:
    store = MemoryObjectStore()
    key = "tenant-a/prod_1/source/page"
    digest = await store.put_verified(key, b"page")
    assert digest == hashlib.sha256(b"page").hexdigest()
    assert await store.get(key) == b"page"
    assert not any(stored.startswith("_tmp/") for stored in store._objects)
    assert await store.put_verified(key, b"page") == digest
    with pytest.raises(ValueError):
        await store.put_verified(key, b"other")
    for unsafe in ("../secret", "/absolute", "tenant/../../secret", "_tmp/hidden"):
        with pytest.raises(ValueError):
            await store.put_verified(unsafe, b"page")
    signed = await store.signed_url(key)
    assert signed.startswith("https://signed.novelcomic.local/")
    assert store.stable_url(key).startswith("https://objects.novelcomic.local/")
