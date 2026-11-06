"""v1 flow 路径的调用量。路由还在时只计数，不改变鉴权结果。"""

from __future__ import annotations

_COUNTS = {"v1_flow": 0}


def reset_legacy_call_volume() -> None:
    _COUNTS["v1_flow"] = 0


def legacy_call_volume() -> dict[str, int]:
    return dict(_COUNTS)


def note_v1_flow_path(path: str) -> None:
    normalized = path.rstrip("/") or "/"
    if normalized == "/api/v1/flow" or normalized.startswith("/api/v1/flow/"):
        _COUNTS["v1_flow"] += 1
