"""At-least-once outbox repository protocol."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class OutboxEvent:
    event_id: str
    aggregate_id: str
    type: str
    payload: dict[str, Any]
    available_at: datetime
    attempt: int


@dataclass(frozen=True, slots=True)
class NewOutboxEvent:
    event_id: str
    aggregate_id: str
    type: str
    payload: dict[str, Any]
    available_at: datetime | None = None


class OutboxRepository(Protocol):
    async def append(self, event: NewOutboxEvent) -> None:
        """Append in the same transaction as the aggregate state change."""

    async def claim(
        self,
        *,
        owner: str,
        limit: int,
        lease_seconds: int,
    ) -> list[OutboxEvent]:
        """Claim unpublished events using a PostgreSQL lease."""

    async def mark_published(self, event_id: str, owner: str) -> bool:
        """Publish only when the caller still owns the lease."""

    async def release(
        self,
        event_id: str,
        owner: str,
        available_at: datetime,
    ) -> bool:
        """Release a failed dispatch for a later attempt."""
