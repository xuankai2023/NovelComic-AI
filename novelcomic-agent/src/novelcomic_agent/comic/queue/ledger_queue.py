"""Ledger-backed outbox and worker lease adapters."""

from __future__ import annotations

from datetime import datetime

from ..persistence.ledger import Ledger
from ..persistence.rows import JobRow, OutboxRow, utcnow
from .job_lease import JobLeaseRepository, WorkerJob
from .outbox_repository import NewOutboxEvent, OutboxEvent, OutboxRepository


class LedgerOutboxRepository(OutboxRepository):
    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def append(self, event: NewOutboxEvent) -> None:
        async with self._ledger.transaction() as session:
            now = _session_now(session)
            await session.insert_outbox(
                OutboxRow(
                    event_id=event.event_id,
                    aggregate_id=event.aggregate_id,
                    type=event.type,
                    payload=event.payload,
                    available_at=event.available_at or now,
                    published_at=None,
                    attempt=0,
                    lease_owner=None,
                    lease_expires_at=None,
                    created_at=now,
                )
            )

    async def claim(
        self,
        *,
        owner: str,
        limit: int,
        lease_seconds: int,
    ) -> list[OutboxEvent]:
        async with self._ledger.transaction() as session:
            rows = await session.claim_outbox(
                owner=owner,
                limit=limit,
                lease_seconds=lease_seconds,
            )
        return [
            OutboxEvent(
                event_id=row.event_id,
                aggregate_id=row.aggregate_id,
                type=row.type,
                payload=row.payload,
                available_at=row.available_at,
                attempt=row.attempt,
            )
            for row in rows
        ]

    async def mark_published(self, event_id: str, owner: str) -> bool:
        async with self._ledger.transaction() as session:
            return await session.mark_outbox_published(event_id, owner)

    async def release(
        self,
        event_id: str,
        owner: str,
        available_at: datetime,
    ) -> bool:
        async with self._ledger.transaction() as session:
            return await session.release_outbox(event_id, owner, available_at)


class LedgerJobLeaseRepository(JobLeaseRepository):
    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def enqueue(self, job: JobRow) -> None:
        async with self._ledger.transaction() as session:
            await session.insert_job(job)

    async def claim(
        self,
        *,
        job_type: str,
        owner: str,
        lease_seconds: int,
    ) -> WorkerJob | None:
        async with self._ledger.transaction() as session:
            row = await session.claim_job(
                job_type=job_type,
                owner=owner,
                lease_seconds=lease_seconds,
            )
        if row is None or row.lease_owner is None or row.lease_expires_at is None:
            return None
        return WorkerJob(
            job_key=row.job_key,
            type=row.type,
            payload=row.payload,
            attempt=row.attempt,
            lease_owner=row.lease_owner,
            lease_expires_at=row.lease_expires_at,
        )

    async def heartbeat(
        self,
        *,
        job_key: str,
        owner: str,
        lease_seconds: int,
    ) -> bool:
        async with self._ledger.transaction() as session:
            return await session.heartbeat_job(
                job_key=job_key,
                owner=owner,
                lease_seconds=lease_seconds,
            )

    async def complete(self, *, job_key: str, owner: str) -> bool:
        async with self._ledger.transaction() as session:
            return await session.complete_job(job_key=job_key, owner=owner)

    async def fail(self, *, job_key: str, owner: str, error_code: str) -> bool:
        async with self._ledger.transaction() as session:
            return await session.fail_job(job_key=job_key, owner=owner, error_code=error_code)


def _session_now(session: object) -> datetime:
    clock = getattr(session, "_clock", None)
    if callable(clock):
        return clock()
    return utcnow()
