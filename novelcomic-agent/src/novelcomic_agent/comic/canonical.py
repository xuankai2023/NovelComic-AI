"""Canonical JSON hashing aligned with Remotion ``stableStringify``."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def hash_content(value: Any) -> str:
    """SHA-256 hex digest of a stable JSON document."""

    return hashlib.sha256(stable_stringify(value).encode("utf-8")).hexdigest()


def stable_stringify(value: Any) -> str:
    """Serialize with sorted object keys and JSON number/string rules."""

    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("cannot hash a non-finite number")
        if value.is_integer():
            return str(int(value))
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = [
            f"{json.dumps(str(key), ensure_ascii=False)}:{stable_stringify(value[key])}"
            for key in sorted(value)
        ]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def project_content_hash(project: dict[str, Any]) -> str:
    """Hash the same project fields Remotion uses for ``projectContentHash``."""

    return hash_content(
        {
            "schemaVersion": project.get("schemaVersion", 1),
            "fps": project["fps"],
            "compositionWidth": project["compositionWidth"],
            "compositionHeight": project["compositionHeight"],
            "tracks": project.get("tracks", []),
            "items": project.get("items", {}),
            "assets": project.get("assets", {}),
            "deletedAssets": project.get("deletedAssets", []),
            "shots": project.get("shots", []),
        }
    )
