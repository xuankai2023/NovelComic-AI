"""Tenant-scoped object keys. Filenames are rejected rather than rewritten."""

from __future__ import annotations

import re

_SEGMENT = re.compile(r"^[A-Za-z0-9._:-]+$")
_CHECKSUM = re.compile(r"^[a-f0-9]{64}$")
_ROOTS = ("source", "artifacts", "renders", "preview", "delivery")


def source_object_key(
    *,
    tenant_id: str,
    production_id: str,
    page_id: str,
    checksum: str,
) -> str:
    filename = f"{_segment(page_id, 'page')}-{_checksum(checksum)}"
    return _join(tenant_id, production_id, "source", filename)


def artifact_object_key(
    *,
    tenant_id: str,
    production_id: str,
    stage: str,
    name: str,
    checksum: str,
) -> str:
    return _join(
        tenant_id,
        production_id,
        "artifacts",
        _segment(stage, "stage"),
        f"{_segment(name, 'name')}-{_checksum(checksum)}",
    )


def render_object_key(
    *,
    tenant_id: str,
    production_id: str,
    batch_id: str,
    checksum: str,
) -> str:
    return _join(
        tenant_id,
        production_id,
        "renders",
        f"{_segment(batch_id, 'batch')}-{_checksum(checksum)}.mp4",
    )


def preview_object_key(
    *,
    tenant_id: str,
    production_id: str,
    name: str,
    checksum: str,
) -> str:
    return _join(
        tenant_id,
        production_id,
        "preview",
        f"{_segment(name, 'name')}-{_checksum(checksum)}",
    )


def delivery_object_key(
    *,
    tenant_id: str,
    production_id: str,
    name: str,
    checksum: str,
) -> str:
    return _join(
        tenant_id,
        production_id,
        "delivery",
        f"{_segment(name, 'name')}-{_checksum(checksum)}",
    )


def _join(tenant_id: str, production_id: str, root: str, *rest: str) -> str:
    if root not in _ROOTS:
        raise ValueError("unknown object root")
    parts = [_segment(tenant_id, "tenant"), _segment(production_id, "production"), root, *rest]
    return "/".join(parts)


def _segment(value: str, label: str) -> str:
    if not isinstance(value, str) or value in {".", ".."} or not _SEGMENT.fullmatch(value):
        raise ValueError(f"unsafe object {label}")
    return value


def _checksum(value: str) -> str:
    if not isinstance(value, str) or not _CHECKSUM.fullmatch(value):
        raise ValueError("object checksum must be a sha256 hex digest")
    return value
