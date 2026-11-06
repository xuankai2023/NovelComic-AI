"""Publish claimed outbox rows to the durable comic worker queue."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any, Protocol

from ..persistence.ledger import Ledger
from ..persistence.rows import utcnow
from .ledger_queue import LedgerOutboxRepository
from .outbox_repository import OutboxEvent

logger = logging.getLogger(__name__)

Publish = Callable[[dict[str, Any]], Awaitable[None]]


class WorkerQueue(Protocol):
    async def publish(self, body: dict[str, Any]) -> None:
        """Publish one durable worker message. Return only after broker confirm."""

    async def consume(self, handler: Callable[[dict[str, Any]], Awaitable[str]]) -> None:
        """Deliver messages to ``handler``, which returns ``ack`` or ``requeue``."""

    async def aclose(self) -> None:
        """Stop this queue client. The shared connection stays open."""


def worker_message(event: OutboxEvent) -> dict[str, Any]:
    """Envelope the ledger payload with the outbox identity."""

    message = dict(event.payload)
    message["eventId"] = event.event_id
    message["type"] = event.type
    return message


def publish_retry_delay(attempt: int) -> timedelta:
    """Back off from the attempt count already stored on the claimed row."""

    exponent = min(max(attempt, 1), 6)
    return timedelta(seconds=min(60, 2**exponent))


class OutboxPublisher:
    """Claim unpublished rows, confirm them on the broker, then mark them published."""

    def __init__(
        self,
        ledger: Ledger,
        queue: WorkerQueue | None,
        *,
        owner: str,
        clock: Callable[[], datetime] | None = None,
        lease_seconds: int = 60,
        batch_size: int = 16,
    ) -> None:
        self._outbox = LedgerOutboxRepository(ledger)
        self._queue = queue
        self._owner = owner
        self._clock = clock or utcnow
        self._lease_seconds = lease_seconds
        self._batch_size = batch_size

    def bind_queue(self, queue: WorkerQueue | None) -> None:
        self._queue = queue

    async def publish_available(self) -> int:
        queue = self._queue
        if queue is None:
            raise ConnectionError("comic worker queue is not connected")
        events = await self._outbox.claim(
            owner=self._owner,
            limit=self._batch_size,
            lease_seconds=self._lease_seconds,
        )
        published = 0
        for index, event in enumerate(events):
            try:
                await queue.publish(worker_message(event))
            except Exception:
                logger.exception("comic outbox publish failed for %s", event.event_id)
                await self._release_all(events[index:])
                raise
            if not await self._outbox.mark_published(event.event_id, self._owner):
                logger.warning(
                    "comic outbox %s was confirmed but the publish lease was lost",
                    event.event_id,
                )
                continue
            published += 1
        return published

    async def _release_all(self, events: list[OutboxEvent]) -> None:
        for event in events:
            available_at = self._clock() + publish_retry_delay(event.attempt)
            await self._outbox.release(event.event_id, self._owner, available_at)
