"""Legacy model id lookups. Already-prefixed ids are not counted here."""

from __future__ import annotations

_COUNTS = {"legacy_model_id": 0}


def reset_legacy_call_volume() -> None:
    _COUNTS["legacy_model_id"] = 0


def legacy_call_volume() -> dict[str, int]:
    return dict(_COUNTS)


def note_legacy_model_id() -> None:
    _COUNTS["legacy_model_id"] += 1
