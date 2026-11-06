"""Worker and outbox leases have one owner and can be stolen after expiry."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.persistence.rows import JobRow
from novelcomic_agent.comic.queue.ledger_queue import (
    LedgerJobLeaseRepository,
    LedgerOutboxRepository,
)
from novelcomic_agent.comic.queue.outbox_repository import NewOutboxEvent


class ManualClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


async def test_job_lease_is_exclusive_until_it_expires() -> None:
    clock = ManualClock()
    leases = LedgerJobLeaseRepository(MemoryLedger(clock))
    await leases.enqueue(
        JobRow(
            job_key="job-1",
            type="comic.worker",
            payload={"productionId": "prod_1"},
            status="pending",
            attempt=0,
            lease_owner=None,
            lease_expires_at=None,
            heartbeat_at=None,
            last_error_code=None,
            created_at=clock.now,
            updated_at=clock.now,
        )
    )
    first = await leases.claim(job_type="comic.worker", owner="worker-a", lease_seconds=10)
    second = await leases.claim(job_type="comic.worker", owner="worker-b", lease_seconds=10)
    assert first is not None and first.lease_owner == "worker-a"
    assert second is None
    assert await leases.heartbeat(job_key="job-1", owner="worker-b", lease_seconds=10) is False

    clock.now += timedelta(seconds=11)
    stolen = await leases.claim(job_type="comic.worker", owner="worker-b", lease_seconds=10)
    assert stolen is not None and stolen.lease_owner == "worker-b"
    assert await leases.complete(job_key="job-1", owner="worker-a") is False
    assert await leases.complete(job_key="job-1", owner="worker-b") is True


async def test_outbox_claim_is_exclusive() -> None:
    clock = ManualClock()
    outbox = LedgerOutboxRepository(MemoryLedger(clock))
    await outbox.append(
        NewOutboxEvent(
            event_id="evt-1",
            aggregate_id="prod_1",
            type="comic.worker",
            payload={"worker": "analyze"},
        )
    )
    first = await outbox.claim(owner="worker-a", limit=10, lease_seconds=10)
    second = await outbox.claim(owner="worker-b", limit=10, lease_seconds=10)
    assert [event.event_id for event in first] == ["evt-1"]
    assert second == []
    assert await outbox.mark_published("evt-1", "worker-b") is False
    clock.now += timedelta(seconds=11)
    stolen = await outbox.claim(owner="worker-b", limit=10, lease_seconds=10)
    assert [event.event_id for event in stolen] == ["evt-1"]
    assert await outbox.mark_published("evt-1", "worker-a") is False
    assert await outbox.mark_published("evt-1", "worker-b") is True


async def test_outbox_claim_waits_until_available_at() -> None:
    clock = ManualClock()
    outbox = LedgerOutboxRepository(MemoryLedger(clock))
    await outbox.append(
        NewOutboxEvent(
            event_id="evt-later",
            aggregate_id="prod_1",
            type="comic.worker",
            payload={"worker": "analyze"},
            available_at=clock.now + timedelta(seconds=10),
        )
    )
    assert await outbox.claim(owner="worker-a", limit=10, lease_seconds=10) == []
    clock.now += timedelta(seconds=10)
    claimed = await outbox.claim(owner="worker-a", limit=10, lease_seconds=10)
    assert [event.event_id for event in claimed] == ["evt-later"]
