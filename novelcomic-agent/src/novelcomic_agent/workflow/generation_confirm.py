"""Pending generation cards. Confirm compares pending.user_id with the caller."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PendingGeneration:
    confirm_id: str
    user_id: str
    session_id: str = ""


_pending: dict[str, PendingGeneration] = {}


def store_pending_generation(pending: PendingGeneration) -> None:
    _pending[pending.confirm_id] = pending


def get_pending_generation(confirm_id: str) -> PendingGeneration | None:
    return _pending.get(confirm_id)


def clear_pending_generations() -> None:
    _pending.clear()
