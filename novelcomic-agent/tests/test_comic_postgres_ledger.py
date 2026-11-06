"""PostgreSQL ledger: migrations, CAS, leases, and compose replay."""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.drafts.apply_compose_command import ComposeCommandApplier
from novelcomic_agent.comic.persistence.migrate import apply_migrations
from novelcomic_agent.comic.persistence.postgres import PostgresLedger, create_pool
from novelcomic_agent.comic.persistence.rows import (
    AlertRow,
    ArtifactRow,
    BatchRow,
    DeliveryRow,
    JobRow,
    OutboxRow,
    TombstoneRow,
    utcnow,
)
from novelcomic_agent.comic.rendering.commands import compose_command
from novelcomic_agent.comic.repositories.draft_repository import LedgerDraftRepository
from novelcomic_agent.comic.repositories.production_repository import ProductionRepository
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import ScriptedRemotion, empty_project, production_request

ADMIN_DSN = os.environ.get(
    "COMIC_TEST_ADMIN_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
)
_BEHAVIOR_DB = "novelcomic_ledger_test"
_MIGRATION_DB = "novelcomic_ledger_migrate"
_TRUNCATE = """
TRUNCATE TABLE
  alerts,
  object_tombstones,
  deliveries,
  worker_jobs,
  outbox_events,
  output_batch_renders,
  shot_budgets,
  cost_entries,
  asset_artifacts,
  compose_commands,
  draft_revisions,
  drafts,
  idempotency_keys,
  productions
RESTART IDENTITY CASCADE
"""


class ManualClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


def _dsn(database: str) -> str:
    return ADMIN_DSN.rsplit("/", 1)[0] + "/" + database


def _digest(text: str) -> str:
    return text * 64 if len(text) == 1 else text


@pytest.fixture
async def ledger():
    pool = await _open_behavior_pool()
    try:
        async with pool.acquire() as conn:
            await conn.execute(_TRUNCATE)
        yield PostgresLedger(pool)
    finally:
        await pool.close()


async def test_empty_database_records_each_migration_once() -> None:
    if not await _postgres_available():
        pytest.skip("PostgreSQL is not available")
    await _ensure_database(_MIGRATION_DB)
    dsn = _dsn(_MIGRATION_DB)
    await _reset_public(dsn)
    pool = await create_pool(dsn, min_size=1, max_size=2)
    try:
        first = await apply_migrations(pool)
        second = await apply_migrations(pool)
        async with pool.acquire() as conn:
            versions = [
                row["version"]
                for row in await conn.fetch(
                    "SELECT version FROM schema_migrations ORDER BY version"
                )
            ]
            tables = {
                row["relname"]
                for row in await conn.fetch(
                    """
                    SELECT relname FROM pg_class
                    WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
                    """
                )
            }
    finally:
        await pool.close()
    assert first == [
        "0001_initial.sql",
        "0002_stage_b.sql",
        "0003_stage_e_ledger.sql",
    ]
    assert second == []
    assert versions == first
    assert {"deliveries", "object_tombstones", "alerts", "schema_migrations"} <= tables


async def test_state_and_outbox_roll_back_together(ledger: PostgresLedger) -> None:
    productions = ProductionRepository(ledger)
    project = empty_project()
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(request_id="rollback"),
        project=project,
        content_hash=project_content_hash(project),
        production_id="prod_rollback",
        project_id="prj_rollback",
    )
    before = await productions.list_outbox(accepted.production_id)
    with pytest.raises(RuntimeError, match="boom"):
        async with ledger.transaction() as session:
            row = await session.get_production(accepted.production_id)
            assert row is not None
            row.state = ProductionState.DELIVERED.value
            await session.save_production(row, expected_version=row.version)
            now = utcnow()
            await session.insert_outbox(
                OutboxRow(
                    event_id="evt-boom",
                    aggregate_id=accepted.production_id,
                    type="production.state.changed",
                    payload={"state": "DELIVERED"},
                    available_at=now,
                    published_at=None,
                    attempt=0,
                    lease_owner=None,
                    lease_expires_at=None,
                    created_at=now,
                )
            )
            raise RuntimeError("boom")
    row = await productions.get_row(accepted.production_id)
    assert row.state == ProductionState.CREATED.value
    assert row.version == 0
    events = await productions.list_outbox(accepted.production_id)
    assert [event.event_id for event in events] == [event.event_id for event in before]


async def test_conflicting_production_version_does_not_write(ledger: PostgresLedger) -> None:
    productions = ProductionRepository(ledger)
    accepted = await _accept(productions, "prod_cas", "prj_cas", "req-cas")
    ready = asyncio.Event()
    release = asyncio.Event()

    async def first() -> object:
        async with ledger.transaction() as session:
            row = await session.get_production(accepted.production_id)
            assert row is not None
            ready.set()
            await release.wait()
            row.state = ProductionState.INGESTING.value
            return await session.save_production(row, expected_version=0)

    async def second() -> object:
        await ready.wait()
        async with ledger.transaction() as session:
            row = await session.get_production(accepted.production_id)
            assert row is not None
            row.state = ProductionState.INGESTING.value
            saved = await session.save_production(row, expected_version=0)
        release.set()
        return saved

    stale, saved = await asyncio.gather(first(), second())
    assert saved is not None and saved.version == 1
    assert stale is None
    current = await productions.get_row(accepted.production_id)
    assert current.version == 1
    assert current.state == ProductionState.INGESTING.value


async def test_concurrent_outbox_and_job_claims_grant_one_lease(ledger: PostgresLedger) -> None:
    now = utcnow()
    async with ledger.transaction() as session:
        await session.insert_outbox(
            OutboxRow(
                event_id="evt-lease",
                aggregate_id="prod_lease",
                type="comic.worker",
                payload={"worker": "analyze"},
                available_at=now,
                published_at=None,
                attempt=0,
                lease_owner=None,
                lease_expires_at=None,
                created_at=now,
            )
        )
        await session.insert_job(
            JobRow(
                job_key="job-lease",
                type="comic.worker",
                payload={"productionId": "prod_lease"},
                status="pending",
                attempt=0,
                lease_owner=None,
                lease_expires_at=None,
                heartbeat_at=None,
                last_error_code=None,
                created_at=now,
                updated_at=now,
            )
        )
    outbox = await _one_winner(
        ledger,
        lambda session: session.claim_outbox(owner="worker-a", limit=10, lease_seconds=30),
        lambda session: session.claim_outbox(owner="worker-b", limit=10, lease_seconds=30),
    )
    assert [row.event_id for row in outbox[0]] == ["evt-lease"]
    assert outbox[1] == []
    jobs = await _one_winner(
        ledger,
        lambda session: session.claim_job(
            job_type="comic.worker", owner="worker-a", lease_seconds=30
        ),
        lambda session: session.claim_job(
            job_type="comic.worker", owner="worker-b", lease_seconds=30
        ),
    )
    assert jobs[0] is not None and jobs[0].lease_owner == "worker-a"
    assert jobs[1] is None


async def test_outbox_claim_waits_until_available_at(ledger: PostgresLedger) -> None:
    later = utcnow() + timedelta(hours=1)
    async with ledger.transaction() as session:
        await session.insert_outbox(
            OutboxRow(
                event_id="evt-later",
                aggregate_id="prod_later",
                type="comic.worker",
                payload={"worker": "analyze"},
                available_at=later,
                published_at=None,
                attempt=0,
                lease_owner=None,
                lease_expires_at=None,
                created_at=later,
            )
        )
        claimed = await session.claim_outbox(owner="worker-a", limit=10, lease_seconds=30)
    assert claimed == []


async def test_expired_lease_can_be_claimed_again(ledger: PostgresLedger) -> None:
    clock = ManualClock()
    timed = PostgresLedger(ledger._pool, clock)
    async with timed.transaction() as session:
        await session.insert_job(
            JobRow(
                job_key="job-expire",
                type="comic.worker",
                payload={},
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
    async with timed.transaction() as session:
        first = await session.claim_job(job_type="comic.worker", owner="worker-a", lease_seconds=10)
    assert first is not None and first.lease_owner == "worker-a"
    async with timed.transaction() as session:
        blocked = await session.claim_job(
            job_type="comic.worker", owner="worker-b", lease_seconds=10
        )
    assert blocked is None
    clock.now += timedelta(seconds=11)
    async with timed.transaction() as session:
        stolen = await session.claim_job(
            job_type="comic.worker", owner="worker-b", lease_seconds=10
        )
    assert stolen is not None and stolen.lease_owner == "worker-b"
    assert stolen.attempt == 2


async def test_replaying_a_compose_command_does_not_bump_revision(ledger: PostgresLedger) -> None:
    productions = ProductionRepository(ledger)
    accepted = await _accept(productions, "prod_compose", "prj_compose", "compose")
    drafts = LedgerDraftRepository(ledger)
    applier = ComposeCommandApplier(drafts, ScriptedRemotion())
    command = compose_command(accepted.project_id, "shot/edit", {"shotId": "shot-a", "seed": 1})
    first = await applier.apply(command)
    second = await applier.apply(command)
    assert first.resulting_revision == second.resulting_revision == 1
    assert (await drafts.get(accepted.project_id)).revision == 1


async def test_same_idempotency_key_replays_and_a_different_hash_conflicts(
    ledger: PostgresLedger,
) -> None:
    productions = ProductionRepository(ledger)
    project = empty_project()
    content_hash = project_content_hash(project)
    request = production_request(request_id="same-key")
    first = await productions.accept(
        tenant_id="tenant-a",
        request=request,
        project=project,
        content_hash=content_hash,
        production_id="prod_same",
        project_id="prj_same",
    )
    second = await productions.accept(
        tenant_id="tenant-a",
        request=request,
        project=project,
        content_hash=content_hash,
        production_id="prod_other",
        project_id="prj_other",
    )
    assert second.replayed is True
    assert second.production_id == first.production_id
    with pytest.raises(ComicServiceError) as caught:
        await productions.accept(
            tenant_id="tenant-a",
            request=production_request(request_id="same-key", project_limit="50.00"),
            project=project,
            content_hash=content_hash,
            production_id="prod_third",
            project_id="prj_third",
        )
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert caught.value.body.retryable is False


async def test_stage_e_rows_round_trip(ledger: PostgresLedger) -> None:
    productions = ProductionRepository(ledger)
    accepted = await _accept(productions, "prod_rows", "prj_rows", "rows")
    now = utcnow()
    digest = _digest("a")
    async with ledger.transaction() as session:
        await session.insert_artifact(
            ArtifactRow(
                artifact_id="art_1",
                tenant_id="tenant-a",
                project_id=accepted.project_id,
                shot_id=None,
                stage="ingest",
                input_hash=digest,
                provider="test",
                provider_request_id=None,
                status="completed",
                urls=["https://cdn.example/page.png"],
                checksums=[digest],
                diagnostics={"ok": True},
                cost_fen=0,
                attempt=1,
                created_at=now,
                updated_at=now,
            )
        )
        await session.insert_batch(
            BatchRow(
                output_batch_render_id="batch_1",
                project_id=accepted.project_id,
                batch_id="batch-a",
                content_hash=digest,
                render_id=None,
                bucket_name=None,
                status="pending",
                url=None,
                checksum=None,
                object_key=None,
                frame_from=0,
                frame_to=30,
                progress=0,
                attempt=0,
                shot_ids=["shot-a"],
                required=True,
                render_config={"scale": 1},
                created_at=now,
                updated_at=now,
            )
        )
        await session.insert_delivery(
            DeliveryRow(
                delivery_id="del_1",
                tenant_id="tenant-a",
                production_id=accepted.production_id,
                project_id=accepted.project_id,
                package_input_hash=digest,
                content_hash=digest,
                object_key="packages/del_1.zip",
                checksum=digest,
                size_bytes=12,
                status="active",
                url_generation=1,
                manifest_json={"files": []},
                play_order=["shot-a"],
                created_at=now,
                revoked_at=None,
            )
        )
        await session.insert_tombstone(
            TombstoneRow(
                tombstone_id="tomb_1",
                tenant_id="tenant-a",
                object_key="packages/del_1.zip",
                category="package",
                status="requested",
                reason="retention",
                retain_until=None,
                requested_at=now,
                deleted_at=None,
                result=None,
            )
        )
        await session.insert_alert(
            AlertRow(
                dedup_key="alert_1",
                tenant_id="tenant-a",
                production_id=accepted.production_id,
                stage="render",
                error_code="RENDER_FAILED",
                window_start=now,
                status="open",
                summary="render failed",
                details={"attempt": 1},
                created_at=now,
                updated_at=now,
            )
        )
    async with ledger.transaction() as session:
        artifact = await session.find_artifact(
            project_id=accepted.project_id,
            stage="ingest",
            input_hash=digest,
            shot_id=None,
        )
        batch = await session.get_batch("batch_1")
        delivery = await session.find_delivery(accepted.production_id, digest)
        tombstone = await session.find_tombstone("tenant-a", "packages/del_1.zip")
        alert = await session.get_alert("alert_1")
    assert artifact is not None and artifact.checksums == [digest]
    assert batch is not None and batch.shot_ids == ["shot-a"]
    assert delivery is not None and delivery.object_key == "packages/del_1.zip"
    assert tombstone is not None and tombstone.status == "requested"
    assert alert is not None and alert.details == {"attempt": 1}


async def _accept(
    productions: ProductionRepository,
    production_id: str,
    project_id: str,
    request_id: str,
):
    project = empty_project()
    return await productions.accept(
        tenant_id="tenant-a",
        request=production_request(request_id=request_id),
        project=project,
        content_hash=project_content_hash(project),
        production_id=production_id,
        project_id=project_id,
    )


async def _one_winner(ledger: PostgresLedger, first_call, second_call):
    started = asyncio.Event()
    release = asyncio.Event()

    async def first():
        async with ledger.transaction() as session:
            rows = await first_call(session)
            started.set()
            await release.wait()
            return rows

    async def second():
        await started.wait()
        async with ledger.transaction() as session:
            return await second_call(session)

    pending_first = asyncio.create_task(first())
    pending_second = asyncio.create_task(second())
    try:
        skipped = await asyncio.wait_for(pending_second, timeout=2)
    finally:
        release.set()
    held = await pending_first
    return held, skipped


async def _open_behavior_pool() -> asyncpg.Pool:
    if not await _postgres_available():
        pytest.skip("PostgreSQL is not available")
    await _ensure_database(_BEHAVIOR_DB)
    pool = await create_pool(_dsn(_BEHAVIOR_DB), min_size=1, max_size=8)
    try:
        await apply_migrations(pool)
    except Exception:
        await pool.close()
        raise
    return pool


async def _postgres_available() -> bool:
    try:
        conn = await asyncpg.connect(ADMIN_DSN, timeout=2)
    except Exception:
        return False
    await conn.close()
    return True


async def _ensure_database(name: str) -> None:
    conn = await asyncpg.connect(ADMIN_DSN, timeout=2)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name)
        if exists is None:
            await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


async def _reset_public(dsn: str) -> None:
    conn = await asyncpg.connect(dsn, timeout=2)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
        await conn.execute("CREATE SCHEMA public")
    finally:
        await conn.close()
