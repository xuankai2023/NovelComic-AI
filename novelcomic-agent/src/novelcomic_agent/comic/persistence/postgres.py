"""PostgreSQL ledger. One transaction is one asyncpg transaction."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import asyncpg

from .memory import UniqueViolation
from .rows import (
    AlertRow,
    ArtifactRow,
    BatchRow,
    CommandRow,
    CostRow,
    DeliveryRow,
    DraftRevisionRow,
    DraftRow,
    IdempotencyRow,
    JobRow,
    OutboxRow,
    ProductionRow,
    ShotBudgetRow,
    TombstoneRow,
    utcnow,
)

# Unnamed unique constraints get PostgreSQL's default names. Repositories still
# branch on the names MemorySession raises.
_CONSTRAINT_ALIASES = {
    "idempotency_keys_tenant_id_request_id_key": "idempotency_keys_tenant_request_key",
    "compose_commands_project_id_ordinal_key": "compose_commands_project_ordinal_key",
    "compose_commands_command_id_key": "compose_commands_pkey",
    "output_batch_renders_project_id_batch_id_content_hash_key": (
        "output_batch_renders_project_batch_hash_key"
    ),
    "worker_jobs_job_key_key": "worker_jobs_pkey",
}

def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=_json_default)


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    raise TypeError(f"cannot encode {type(value).__name__} as jsonb")


async def init_connection(conn: Any) -> None:
    """Decode jsonb at the driver boundary. Pool proxies cannot be weak-referenced."""

    if getattr(conn, "_novelcomic_jsonb", False):
        return
    await conn.set_type_codec(
        "jsonb",
        encoder=_dumps,
        decoder=json.loads,
        schema="pg_catalog",
        format="text",
    )
    try:
        conn._novelcomic_jsonb = True
    except (AttributeError, TypeError):
        return


async def create_pool(
    dsn: str,
    *,
    min_size: int = 1,
    max_size: int = 10,
) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn,
        min_size=min_size,
        max_size=max_size,
        init=init_connection,
    )


class PostgresLedger:
    """Hold a pool. Each transaction checks out one connection and rolls back on error."""

    def __init__(self, pool: asyncpg.Pool, clock: Callable[[], datetime] | None = None) -> None:
        self._pool = pool
        self._clock = clock or utcnow

    @asynccontextmanager
    async def transaction(self) -> Any:
        async with self._pool.acquire() as conn:
            await init_connection(conn)
            async with conn.transaction():
                yield PostgresSession(conn, self._clock)


class PostgresSession:
    """Read and write ledger rows. Callers keep using the repository rules."""

    def __init__(self, conn: asyncpg.Connection, clock: Callable[[], datetime]) -> None:
        self._conn = conn
        self._clock = clock

    async def get_production(self, production_id: str) -> ProductionRow | None:
        return _production(
            await self._conn.fetchrow(
                "SELECT * FROM productions WHERE production_id = $1",
                production_id,
            )
        )

    async def find_production_by_request(
        self,
        tenant_id: str,
        request_id: str,
    ) -> ProductionRow | None:
        return _production(
            await self._conn.fetchrow(
                """
                SELECT production.*
                FROM idempotency_keys AS key
                JOIN productions AS production
                  ON production.production_id = key.production_id
                WHERE key.tenant_id = $1 AND key.request_id = $2
                """,
                tenant_id,
                request_id,
            )
        )

    async def insert_production(self, row: ProductionRow) -> None:
        await self._insert(
            "productions",
            {
                "production_id": row.production_id,
                "project_id": row.project_id,
                "tenant_id": row.tenant_id,
                "state": row.state,
                "phase": row.phase,
                "version": row.version,
                "fixing_count": row.fixing_count,
                "cancel_requested_at": row.cancel_requested_at,
                "budget_limit_fen": row.budget_limit_fen,
                "shot_limit_fen": row.shot_limit_fen,
                "max_paid_calls_per_shot": row.max_paid_calls_per_shot,
                "reserved_cost_fen": row.reserved_cost_fen,
                "actual_cost_fen": row.actual_cost_fen,
                "can_produce_playable": row.can_produce_playable,
                "degraded": row.degraded,
                "last_error_code": row.last_error_code,
                "last_error_message": row.last_error_message,
                "request_hash": row.request_hash,
                "request_json": row.request_json,
                "stage_facts": row.stage_facts,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def insert_idempotency(self, row: IdempotencyRow) -> None:
        await self._insert(
            "idempotency_keys",
            {
                "tenant_id": row.tenant_id,
                "request_id": row.request_id,
                "payload_hash": row.payload_hash,
                "production_id": row.production_id,
                "created_at": row.created_at,
            },
        )

    async def save_production(
        self,
        row: ProductionRow,
        *,
        expected_version: int,
    ) -> ProductionRow | None:
        saved = await self._fetchrow(
            """
            UPDATE productions SET
              state = $1,
              phase = $2,
              version = $3,
              fixing_count = $4,
              cancel_requested_at = $5,
              budget_limit_fen = $6,
              shot_limit_fen = $7,
              max_paid_calls_per_shot = $8,
              reserved_cost_fen = $9,
              actual_cost_fen = $10,
              can_produce_playable = $11,
              degraded = $12,
              last_error_code = $13,
              last_error_message = $14,
              request_hash = $15,
              request_json = $16,
              stage_facts = $17,
              updated_at = $18
            WHERE production_id = $19
              AND version = $20
              AND tenant_id = $21
              AND project_id = $22
            RETURNING *
            """,
            row.state,
            row.phase,
            expected_version + 1,
            row.fixing_count,
            row.cancel_requested_at,
            row.budget_limit_fen,
            row.shot_limit_fen,
            row.max_paid_calls_per_shot,
            row.reserved_cost_fen,
            row.actual_cost_fen,
            row.can_produce_playable,
            row.degraded,
            row.last_error_code,
            row.last_error_message,
            row.request_hash,
            row.request_json,
            row.stage_facts,
            self._clock(),
            row.production_id,
            expected_version,
            row.tenant_id,
            row.project_id,
        )
        return _production(saved)

    async def insert_draft(self, row: DraftRow) -> None:
        await self._insert(
            "drafts",
            {
                "project_id": row.project_id,
                "revision": row.revision,
                "project_json": row.project_json,
                "content_hash": row.content_hash,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def insert_draft_revision(self, row: DraftRevisionRow) -> None:
        await self._insert(
            "draft_revisions",
            {
                "project_id": row.project_id,
                "revision": row.revision,
                "project_json": row.project_json,
                "content_hash": row.content_hash,
                "command_id": row.command_id,
                "created_at": row.created_at,
            },
        )

    async def get_draft(self, project_id: str) -> DraftRow | None:
        return _draft(
            await self._conn.fetchrow("SELECT * FROM drafts WHERE project_id = $1", project_id)
        )

    async def get_draft_revision(
        self,
        project_id: str,
        revision: int,
    ) -> DraftRevisionRow | None:
        return _draft_revision(
            await self._conn.fetchrow(
                """
                SELECT * FROM draft_revisions
                WHERE project_id = $1 AND revision = $2
                """,
                project_id,
                revision,
            )
        )

    async def get_command(self, command_id: str) -> CommandRow | None:
        return _command(
            await self._conn.fetchrow(
                "SELECT * FROM compose_commands WHERE command_id = $1",
                command_id,
            )
        )

    async def find_command_by_ordinal(
        self,
        project_id: str,
        ordinal: int,
    ) -> CommandRow | None:
        return _command(
            await self._conn.fetchrow(
                """
                SELECT * FROM compose_commands
                WHERE project_id = $1 AND ordinal = $2
                """,
                project_id,
                ordinal,
            )
        )

    async def insert_command(self, row: CommandRow) -> None:
        await self._insert(
            "compose_commands",
            {
                "command_id": row.command_id,
                "project_id": row.project_id,
                "ordinal": row.ordinal,
                "name": row.name,
                "input_hash": row.input_hash,
                "expected_revision": row.expected_revision,
                "resulting_revision": row.resulting_revision,
                "status": row.status,
                "attempt": row.attempt,
                "last_error_code": row.last_error_code,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def save_command(self, row: CommandRow) -> None:
        current = await self.get_command(row.command_id)
        if current is None:
            raise KeyError(row.command_id)
        if current.project_id != row.project_id or current.ordinal != row.ordinal:
            raise UniqueViolation("compose_commands_identity")
        await self._execute(
            """
            UPDATE compose_commands SET
              name = $2,
              input_hash = $3,
              expected_revision = $4,
              resulting_revision = $5,
              status = $6,
              attempt = $7,
              last_error_code = $8,
              updated_at = $9
            WHERE command_id = $1
            """,
            row.command_id,
            row.name,
            row.input_hash,
            row.expected_revision,
            row.resulting_revision,
            row.status,
            row.attempt,
            row.last_error_code,
            self._clock(),
        )

    async def commit_draft(
        self,
        *,
        command_id: str,
        project_id: str,
        expected_revision: int,
        new_project: dict[str, Any],
        new_content_hash: str,
    ) -> int | None:
        draft = await self._conn.fetchrow(
            "SELECT * FROM drafts WHERE project_id = $1 FOR UPDATE",
            project_id,
        )
        command = await self._conn.fetchrow(
            "SELECT * FROM compose_commands WHERE command_id = $1 FOR UPDATE",
            command_id,
        )
        if (
            draft is None
            or command is None
            or command["project_id"] != project_id
            or command["status"] != "running"
            or draft["revision"] != expected_revision
            or command["expected_revision"] != expected_revision
        ):
            return None
        now = self._clock()
        new_revision = int(draft["revision"]) + 1
        await self._execute(
            """
            UPDATE drafts
            SET revision = $2, project_json = $3, content_hash = $4, updated_at = $5
            WHERE project_id = $1
            """,
            project_id,
            new_revision,
            new_project,
            new_content_hash,
            now,
        )
        await self._execute(
            """
            INSERT INTO draft_revisions (
              project_id, revision, project_json, content_hash, command_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            """,
            project_id,
            new_revision,
            new_project,
            new_content_hash,
            command_id,
            now,
        )
        await self._execute(
            """
            UPDATE compose_commands
            SET status = 'committed',
                resulting_revision = $2,
                updated_at = $3,
                last_error_code = NULL
            WHERE command_id = $1
            """,
            command_id,
            new_revision,
            now,
        )
        return new_revision

    async def get_artifact(self, artifact_id: str) -> ArtifactRow | None:
        return _artifact(
            await self._conn.fetchrow(
                "SELECT * FROM asset_artifacts WHERE artifact_id = $1",
                artifact_id,
            )
        )

    async def find_artifact(
        self,
        *,
        project_id: str,
        stage: str,
        input_hash: str,
        shot_id: str | None,
    ) -> ArtifactRow | None:
        return _artifact(
            await self._conn.fetchrow(
                """
                SELECT * FROM asset_artifacts
                WHERE project_id = $1 AND stage = $2 AND input_hash = $3
                  AND COALESCE(shot_id, '') = $4
                """,
                project_id,
                stage,
                input_hash,
                shot_id or "",
            )
        )

    async def find_tenant_artifact(
        self,
        *,
        tenant_id: str,
        stage: str,
        input_hash: str,
    ) -> ArtifactRow | None:
        return _artifact(
            await self._conn.fetchrow(
                """
                SELECT * FROM asset_artifacts
                WHERE tenant_id = $1 AND stage = $2 AND input_hash = $3
                  AND status = 'completed'
                ORDER BY created_at ASC, artifact_id ASC
                LIMIT 1
                """,
                tenant_id,
                stage,
                input_hash,
            )
        )

    async def insert_artifact(self, row: ArtifactRow) -> None:
        await self._insert(
            "asset_artifacts",
            {
                "artifact_id": row.artifact_id,
                "tenant_id": row.tenant_id,
                "project_id": row.project_id,
                "shot_id": row.shot_id,
                "stage": row.stage,
                "input_hash": row.input_hash,
                "provider": row.provider,
                "provider_request_id": row.provider_request_id,
                "status": row.status,
                "urls": row.urls,
                "checksums": row.checksums,
                "diagnostics": row.diagnostics,
                "cost_fen": row.cost_fen,
                "attempt": row.attempt,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def save_artifact(self, row: ArtifactRow) -> None:
        current = await self.get_artifact(row.artifact_id)
        if current is None:
            raise KeyError(row.artifact_id)
        if _artifact_identity(current) != _artifact_identity(row):
            raise UniqueViolation("asset_artifacts_reuse_key")
        if current.tenant_id != row.tenant_id:
            raise UniqueViolation("asset_artifacts_tenant")
        await self._execute(
            """
            UPDATE asset_artifacts SET
              provider = $2,
              provider_request_id = $3,
              status = $4,
              urls = $5,
              checksums = $6,
              diagnostics = $7,
              cost_fen = $8,
              attempt = $9,
              updated_at = $10
            WHERE artifact_id = $1
            """,
            row.artifact_id,
            row.provider,
            row.provider_request_id,
            row.status,
            row.urls,
            row.checksums,
            row.diagnostics,
            row.cost_fen,
            row.attempt,
            self._clock(),
        )

    async def get_cost(self, cost_entry_id: str) -> CostRow | None:
        return _cost(
            await self._conn.fetchrow(
                "SELECT * FROM cost_entries WHERE cost_entry_id = $1",
                cost_entry_id,
            )
        )

    async def find_cost_by_operation(
        self,
        production_id: str,
        operation_key: str,
    ) -> CostRow | None:
        return _cost(
            await self._conn.fetchrow(
                """
                SELECT * FROM cost_entries
                WHERE production_id = $1 AND operation_key = $2
                """,
                production_id,
                operation_key,
            )
        )

    async def find_cost_by_provider_request(self, provider_request_id: str) -> CostRow | None:
        if not provider_request_id:
            return None
        return _cost(
            await self._conn.fetchrow(
                "SELECT * FROM cost_entries WHERE provider_request_id = $1",
                provider_request_id,
            )
        )

    async def list_costs(self, production_id: str) -> list[CostRow]:
        rows = await self._conn.fetch(
            """
            SELECT * FROM cost_entries
            WHERE production_id = $1
            ORDER BY created_at ASC, cost_entry_id ASC
            """,
            production_id,
        )
        return [_cost(row) for row in rows]

    async def insert_cost(self, row: CostRow) -> None:
        await self._insert(
            "cost_entries",
            {
                "cost_entry_id": row.cost_entry_id,
                "production_id": row.production_id,
                "shot_id": row.shot_id,
                "provider": row.provider,
                "provider_request_id": _provider_request(row.provider_request_id),
                "operation_key": row.operation_key,
                "reservation_fen": row.reservation_fen,
                "actual_fen": row.actual_fen,
                "refunded_fen": row.refunded_fen,
                "status": row.status,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def save_cost(self, row: CostRow) -> None:
        current = await self.get_cost(row.cost_entry_id)
        if current is None:
            raise KeyError(row.cost_entry_id)
        if current.production_id != row.production_id or current.operation_key != row.operation_key:
            raise UniqueViolation("cost_entries_operation_key_unique")
        provider_request_id = _provider_request(row.provider_request_id)
        if provider_request_id != _provider_request(current.provider_request_id):
            holder = None
            if provider_request_id:
                holder = await self.find_cost_by_provider_request(provider_request_id)
            if holder is not None and holder.cost_entry_id != row.cost_entry_id:
                raise UniqueViolation("cost_entries_provider_request_unique")
        await self._execute(
            """
            UPDATE cost_entries SET
              shot_id = $2,
              provider = $3,
              provider_request_id = $4,
              reservation_fen = $5,
              actual_fen = $6,
              refunded_fen = $7,
              status = $8,
              updated_at = $9
            WHERE cost_entry_id = $1
            """,
            row.cost_entry_id,
            row.shot_id,
            row.provider,
            provider_request_id,
            row.reservation_fen,
            row.actual_fen,
            row.refunded_fen,
            row.status,
            self._clock(),
        )

    async def get_shot_budget(self, production_id: str, shot_id: str) -> ShotBudgetRow | None:
        record = await self._conn.fetchrow(
            """
            SELECT * FROM shot_budgets
            WHERE production_id = $1 AND shot_id = $2
            """,
            production_id,
            shot_id,
        )
        if record is None:
            return None
        return ShotBudgetRow(
            production_id=record["production_id"],
            shot_id=record["shot_id"],
            reserved_fen=int(record["reserved_fen"]),
            actual_fen=int(record["actual_fen"]),
            paid_calls=int(record["paid_calls"]),
        )

    async def save_shot_budget(self, row: ShotBudgetRow) -> None:
        await self._execute(
            """
            INSERT INTO shot_budgets (
              production_id, shot_id, reserved_fen, actual_fen, paid_calls
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (production_id, shot_id) DO UPDATE SET
              reserved_fen = EXCLUDED.reserved_fen,
              actual_fen = EXCLUDED.actual_fen,
              paid_calls = EXCLUDED.paid_calls
            """,
            row.production_id,
            row.shot_id,
            row.reserved_fen,
            row.actual_fen,
            row.paid_calls,
        )

    async def get_batch(self, output_batch_render_id: str) -> BatchRow | None:
        return _batch(
            await self._conn.fetchrow(
                """
                SELECT * FROM output_batch_renders
                WHERE output_batch_render_id = $1
                """,
                output_batch_render_id,
            )
        )

    async def find_batch(
        self,
        *,
        project_id: str,
        batch_id: str,
        content_hash: str,
    ) -> BatchRow | None:
        return _batch(
            await self._conn.fetchrow(
                """
                SELECT * FROM output_batch_renders
                WHERE project_id = $1 AND batch_id = $2 AND content_hash = $3
                """,
                project_id,
                batch_id,
                content_hash,
            )
        )

    async def list_batches(
        self,
        project_id: str,
        content_hash: str | None = None,
    ) -> list[BatchRow]:
        rows = await self._conn.fetch(
            """
            SELECT * FROM output_batch_renders
            WHERE project_id = $1 AND ($2::text IS NULL OR content_hash = $2)
            ORDER BY frame_from ASC, batch_id ASC
            """,
            project_id,
            content_hash,
        )
        return [_batch(row) for row in rows]

    async def insert_batch(self, row: BatchRow) -> None:
        await self._insert(
            "output_batch_renders",
            {
                "output_batch_render_id": row.output_batch_render_id,
                "project_id": row.project_id,
                "batch_id": row.batch_id,
                "content_hash": row.content_hash,
                "render_id": row.render_id,
                "bucket_name": row.bucket_name,
                "status": row.status,
                "url": row.url,
                "checksum": row.checksum,
                "object_key": row.object_key,
                "frame_from": row.frame_from,
                "frame_to": row.frame_to,
                "progress": row.progress,
                "attempt": row.attempt,
                "shot_ids": row.shot_ids,
                "required": row.required,
                "render_config": row.render_config,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def save_batch(self, row: BatchRow) -> None:
        current = await self.get_batch(row.output_batch_render_id)
        if current is None:
            raise KeyError(row.output_batch_render_id)
        if (
            current.project_id != row.project_id
            or current.batch_id != row.batch_id
            or current.content_hash != row.content_hash
        ):
            raise UniqueViolation("output_batch_renders_project_batch_hash_key")
        await self._execute(
            """
            UPDATE output_batch_renders SET
              render_id = $2,
              bucket_name = $3,
              status = $4,
              url = $5,
              checksum = $6,
              object_key = $7,
              frame_from = $8,
              frame_to = $9,
              progress = $10,
              attempt = $11,
              shot_ids = $12,
              required = $13,
              render_config = $14,
              updated_at = $15
            WHERE output_batch_render_id = $1
            """,
            row.output_batch_render_id,
            row.render_id,
            row.bucket_name,
            row.status,
            row.url,
            row.checksum,
            row.object_key,
            row.frame_from,
            row.frame_to,
            row.progress,
            row.attempt,
            row.shot_ids,
            row.required,
            row.render_config,
            self._clock(),
        )

    async def insert_outbox(self, row: OutboxRow) -> None:
        await self._insert(
            "outbox_events",
            {
                "event_id": row.event_id,
                "aggregate_id": row.aggregate_id,
                "type": row.type,
                "payload": row.payload,
                "available_at": row.available_at,
                "published_at": row.published_at,
                "attempt": row.attempt,
                "lease_owner": row.lease_owner,
                "lease_expires_at": row.lease_expires_at,
                "created_at": row.created_at,
            },
        )

    async def list_outbox(self) -> list[OutboxRow]:
        rows = await self._conn.fetch(
            "SELECT * FROM outbox_events ORDER BY created_at ASC, event_id ASC"
        )
        return [_outbox(row) for row in rows]

    async def claim_outbox(self, *, owner: str, limit: int, lease_seconds: int) -> list[OutboxRow]:
        now = self._clock()
        picked = await self._conn.fetch(
            """
            SELECT * FROM outbox_events
            WHERE published_at IS NULL
              AND available_at <= $1
              AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
            ORDER BY available_at ASC, created_at ASC, event_id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
            """,
            now,
            limit,
        )
        if not picked:
            return []
        claimed = await self._fetch(
            """
            UPDATE outbox_events SET
              lease_owner = $2,
              lease_expires_at = $3,
              attempt = attempt + 1
            WHERE event_id = ANY($1::text[])
            RETURNING *
            """,
            [row["event_id"] for row in picked],
            owner,
            now + timedelta(seconds=lease_seconds),
        )
        order = {row["event_id"]: index for index, row in enumerate(picked)}
        claimed.sort(key=lambda row: order[row["event_id"]])
        return [_outbox(row) for row in claimed]

    async def mark_outbox_published(self, event_id: str, owner: str) -> bool:
        now = self._clock()
        status = await self._execute(
            """
            UPDATE outbox_events SET
              published_at = $3,
              lease_owner = NULL,
              lease_expires_at = NULL
            WHERE event_id = $1
              AND published_at IS NULL
              AND lease_owner = $2
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > $3
            """,
            event_id,
            owner,
            now,
        )
        return _updated(status)

    async def release_outbox(
        self,
        event_id: str,
        owner: str,
        available_at: datetime,
    ) -> bool:
        status = await self._execute(
            """
            UPDATE outbox_events SET
              lease_owner = NULL,
              lease_expires_at = NULL,
              available_at = $3
            WHERE event_id = $1
              AND published_at IS NULL
              AND lease_owner = $2
            """,
            event_id,
            owner,
            available_at,
        )
        return _updated(status)

    async def insert_job(self, row: JobRow) -> None:
        await self._insert(
            "worker_jobs",
            {
                "job_key": row.job_key,
                "type": row.type,
                "payload": row.payload,
                "status": row.status,
                "attempt": row.attempt,
                "lease_owner": row.lease_owner,
                "lease_expires_at": row.lease_expires_at,
                "heartbeat_at": row.heartbeat_at,
                "last_error_code": row.last_error_code,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def claim_job(self, *, job_type: str, owner: str, lease_seconds: int) -> JobRow | None:
        now = self._clock()
        picked = await self._conn.fetchrow(
            """
            SELECT job_key FROM worker_jobs
            WHERE type = $1
              AND status IN ('pending', 'running')
              AND (
                status = 'pending'
                OR lease_expires_at IS NULL
                OR lease_expires_at <= $2
              )
            ORDER BY created_at ASC, job_key ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
            """,
            job_type,
            now,
        )
        if picked is None:
            return None
        saved = await self._fetchrow(
            """
            UPDATE worker_jobs SET
              status = 'running',
              lease_owner = $2,
              lease_expires_at = $3,
              heartbeat_at = $4,
              attempt = attempt + 1,
              updated_at = $4
            WHERE job_key = $1
            RETURNING *
            """,
            picked["job_key"],
            owner,
            now + timedelta(seconds=lease_seconds),
            now,
        )
        return _job(saved)

    async def heartbeat_job(self, *, job_key: str, owner: str, lease_seconds: int) -> bool:
        now = self._clock()
        status = await self._execute(
            """
            UPDATE worker_jobs SET
              lease_expires_at = $3,
              heartbeat_at = $4,
              updated_at = $4
            WHERE job_key = $1
              AND status = 'running'
              AND lease_owner = $2
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > $4
            """,
            job_key,
            owner,
            now + timedelta(seconds=lease_seconds),
            now,
        )
        return _updated(status)

    async def complete_job(self, *, job_key: str, owner: str) -> bool:
        now = self._clock()
        status = await self._execute(
            """
            UPDATE worker_jobs SET
              status = 'completed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $3
            WHERE job_key = $1
              AND status = 'running'
              AND lease_owner = $2
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > $3
            """,
            job_key,
            owner,
            now,
        )
        return _updated(status)

    async def fail_job(self, *, job_key: str, owner: str, error_code: str) -> bool:
        now = self._clock()
        status = await self._execute(
            """
            UPDATE worker_jobs SET
              status = 'failed',
              last_error_code = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $4
            WHERE job_key = $1
              AND status = 'running'
              AND lease_owner = $2
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > $4
            """,
            job_key,
            owner,
            error_code,
            now,
        )
        return _updated(status)

    async def get_job(self, job_key: str) -> JobRow | None:
        return _job(
            await self._conn.fetchrow("SELECT * FROM worker_jobs WHERE job_key = $1", job_key)
        )

    async def list_artifacts(self, project_id: str) -> list[ArtifactRow]:
        rows = await self._conn.fetch(
            """
            SELECT * FROM asset_artifacts
            WHERE project_id = $1
            ORDER BY stage ASC, artifact_id ASC
            """,
            project_id,
        )
        return [_artifact(row) for row in rows]

    async def insert_delivery(self, row: DeliveryRow) -> None:
        await self._insert(
            "deliveries",
            {
                "delivery_id": row.delivery_id,
                "tenant_id": row.tenant_id,
                "production_id": row.production_id,
                "project_id": row.project_id,
                "package_input_hash": row.package_input_hash,
                "content_hash": row.content_hash,
                "object_key": row.object_key,
                "checksum": row.checksum,
                "size_bytes": row.size_bytes,
                "status": row.status,
                "url_generation": row.url_generation,
                "manifest_json": row.manifest_json,
                "play_order": row.play_order,
                "created_at": row.created_at,
                "revoked_at": row.revoked_at,
            },
        )

    async def find_delivery(
        self, production_id: str, package_input_hash: str
    ) -> DeliveryRow | None:
        return _delivery(
            await self._conn.fetchrow(
                """
                SELECT * FROM deliveries
                WHERE production_id = $1 AND package_input_hash = $2
                """,
                production_id,
                package_input_hash,
            )
        )

    async def list_deliveries(self, production_id: str | None = None) -> list[DeliveryRow]:
        rows = await self._conn.fetch(
            """
            SELECT * FROM deliveries
            WHERE ($1::text IS NULL OR production_id = $1)
            ORDER BY created_at ASC, delivery_id ASC
            """,
            production_id,
        )
        return [_delivery(row) for row in rows]

    async def save_delivery(self, row: DeliveryRow) -> None:
        existing = await self._conn.fetchrow(
            "SELECT delivery_id FROM deliveries WHERE delivery_id = $1",
            row.delivery_id,
        )
        if existing is None:
            raise KeyError(row.delivery_id)
        await self._execute(
            """
            UPDATE deliveries SET
              tenant_id = $2,
              production_id = $3,
              project_id = $4,
              package_input_hash = $5,
              content_hash = $6,
              object_key = $7,
              checksum = $8,
              size_bytes = $9,
              status = $10,
              url_generation = $11,
              manifest_json = $12,
              play_order = $13,
              created_at = $14,
              revoked_at = $15
            WHERE delivery_id = $1
            """,
            row.delivery_id,
            row.tenant_id,
            row.production_id,
            row.project_id,
            row.package_input_hash,
            row.content_hash,
            row.object_key,
            row.checksum,
            row.size_bytes,
            row.status,
            row.url_generation,
            row.manifest_json,
            row.play_order,
            row.created_at,
            row.revoked_at,
        )

    async def insert_tombstone(self, row: TombstoneRow) -> None:
        await self._insert(
            "object_tombstones",
            {
                "tombstone_id": row.tombstone_id,
                "tenant_id": row.tenant_id,
                "object_key": row.object_key,
                "category": row.category,
                "status": row.status,
                "reason": row.reason,
                "retain_until": row.retain_until,
                "requested_at": row.requested_at,
                "deleted_at": row.deleted_at,
                "result": row.result,
            },
        )

    async def get_tombstone(self, tombstone_id: str) -> TombstoneRow | None:
        return _tombstone(
            await self._conn.fetchrow(
                "SELECT * FROM object_tombstones WHERE tombstone_id = $1",
                tombstone_id,
            )
        )

    async def find_tombstone(self, tenant_id: str, object_key: str) -> TombstoneRow | None:
        return _tombstone(
            await self._conn.fetchrow(
                """
                SELECT * FROM object_tombstones
                WHERE tenant_id = $1 AND object_key = $2
                """,
                tenant_id,
                object_key,
            )
        )

    async def save_tombstone(self, row: TombstoneRow) -> None:
        current = await self.get_tombstone(row.tombstone_id)
        if current is None:
            raise KeyError(row.tombstone_id)
        await self._execute(
            """
            UPDATE object_tombstones SET
              tenant_id = $2,
              object_key = $3,
              category = $4,
              status = $5,
              reason = $6,
              retain_until = $7,
              requested_at = $8,
              deleted_at = $9,
              result = $10
            WHERE tombstone_id = $1
            """,
            row.tombstone_id,
            row.tenant_id,
            row.object_key,
            row.category,
            row.status,
            row.reason,
            row.retain_until,
            row.requested_at,
            row.deleted_at,
            row.result,
        )

    async def insert_alert(self, row: AlertRow) -> None:
        await self._insert(
            "alerts",
            {
                "dedup_key": row.dedup_key,
                "tenant_id": row.tenant_id,
                "production_id": row.production_id,
                "stage": row.stage,
                "error_code": row.error_code,
                "window_start": row.window_start,
                "status": row.status,
                "summary": row.summary,
                "details": row.details,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            },
        )

    async def get_alert(self, dedup_key: str) -> AlertRow | None:
        return _alert(
            await self._conn.fetchrow("SELECT * FROM alerts WHERE dedup_key = $1", dedup_key)
        )

    async def save_alert(self, row: AlertRow) -> None:
        current = await self.get_alert(row.dedup_key)
        if current is None:
            raise KeyError(row.dedup_key)
        await self._execute(
            """
            UPDATE alerts SET
              tenant_id = $2,
              production_id = $3,
              stage = $4,
              error_code = $5,
              window_start = $6,
              status = $7,
              summary = $8,
              details = $9,
              updated_at = $10
            WHERE dedup_key = $1
            """,
            row.dedup_key,
            row.tenant_id,
            row.production_id,
            row.stage,
            row.error_code,
            row.window_start,
            row.status,
            row.summary,
            row.details,
            self._clock(),
        )

    async def _insert(self, table: str, values: dict[str, Any]) -> None:
        columns = list(values)
        placeholders = ", ".join(f"${index}" for index in range(1, len(columns) + 1))
        names = ", ".join(columns)
        await self._execute(
            f"INSERT INTO {table} ({names}) VALUES ({placeholders})",
            *[values[column] for column in columns],
        )

    async def _execute(self, query: str, *args: Any) -> str:
        try:
            return await self._conn.execute(query, *args)
        except asyncpg.UniqueViolationError as exc:
            raise _map_unique(exc) from exc

    async def _fetchrow(self, query: str, *args: Any) -> Any:
        try:
            return await self._conn.fetchrow(query, *args)
        except asyncpg.UniqueViolationError as exc:
            raise _map_unique(exc) from exc

    async def _fetch(self, query: str, *args: Any) -> list[Any]:
        try:
            return list(await self._conn.fetch(query, *args))
        except asyncpg.UniqueViolationError as exc:
            raise _map_unique(exc) from exc


def _map_unique(exc: asyncpg.UniqueViolationError) -> UniqueViolation:
    name = exc.constraint_name or "unique"
    return UniqueViolation(_CONSTRAINT_ALIASES.get(name, name))


def _updated(status: str) -> bool:
    return status.startswith("UPDATE") and status.rsplit(" ", 1)[-1] != "0"


def _provider_request(value: str | None) -> str | None:
    return value or None


def _artifact_identity(row: ArtifactRow) -> tuple[str, str, str, str]:
    return (row.project_id, row.stage, row.input_hash, row.shot_id or "")


def _time(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _time_opt(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return _time(value)


def _obj(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, str):
        value = json.loads(value)
    return dict(value)


def _items(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        value = json.loads(value)
    return list(value)


def _production(record: Mapping[str, Any] | None) -> ProductionRow | None:
    if record is None:
        return None
    return ProductionRow(
        production_id=record["production_id"],
        project_id=record["project_id"],
        tenant_id=record["tenant_id"],
        state=record["state"],
        phase=record["phase"],
        version=int(record["version"]),
        fixing_count=int(record["fixing_count"]),
        cancel_requested_at=_time_opt(record["cancel_requested_at"]),
        budget_limit_fen=int(record["budget_limit_fen"]),
        shot_limit_fen=int(record["shot_limit_fen"]),
        max_paid_calls_per_shot=int(record["max_paid_calls_per_shot"]),
        reserved_cost_fen=int(record["reserved_cost_fen"]),
        actual_cost_fen=int(record["actual_cost_fen"]),
        can_produce_playable=bool(record["can_produce_playable"]),
        degraded=bool(record["degraded"]),
        last_error_code=record["last_error_code"],
        last_error_message=record["last_error_message"],
        request_hash=record["request_hash"] or "",
        request_json=_obj(record["request_json"]),
        stage_facts=_obj(record["stage_facts"]),
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _draft(record: Mapping[str, Any] | None) -> DraftRow | None:
    if record is None:
        return None
    return DraftRow(
        project_id=record["project_id"],
        revision=int(record["revision"]),
        project_json=_obj(record["project_json"]),
        content_hash=record["content_hash"],
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _draft_revision(record: Mapping[str, Any] | None) -> DraftRevisionRow | None:
    if record is None:
        return None
    return DraftRevisionRow(
        project_id=record["project_id"],
        revision=int(record["revision"]),
        project_json=_obj(record["project_json"]),
        content_hash=record["content_hash"],
        command_id=record["command_id"],
        created_at=_time(record["created_at"]),
    )


def _command(record: Mapping[str, Any] | None) -> CommandRow | None:
    if record is None:
        return None
    return CommandRow(
        command_id=record["command_id"],
        project_id=record["project_id"],
        ordinal=int(record["ordinal"]),
        name=record["name"],
        input_hash=record["input_hash"],
        expected_revision=int(record["expected_revision"]),
        resulting_revision=(
            None if record["resulting_revision"] is None else int(record["resulting_revision"])
        ),
        status=record["status"],
        attempt=int(record["attempt"]),
        last_error_code=record["last_error_code"],
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _artifact(record: Mapping[str, Any] | None) -> ArtifactRow | None:
    if record is None:
        return None
    return ArtifactRow(
        artifact_id=record["artifact_id"],
        tenant_id=record["tenant_id"] or "",
        project_id=record["project_id"],
        shot_id=record["shot_id"],
        stage=record["stage"],
        input_hash=record["input_hash"],
        provider=record["provider"],
        provider_request_id=record["provider_request_id"],
        status=record["status"],
        urls=[str(item) for item in _items(record["urls"])],
        checksums=[str(item) for item in _items(record["checksums"])],
        diagnostics=_obj(record["diagnostics"]),
        cost_fen=int(record["cost_fen"]),
        attempt=int(record["attempt"]),
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _cost(record: Mapping[str, Any] | None) -> CostRow | None:
    if record is None:
        return None
    return CostRow(
        cost_entry_id=record["cost_entry_id"],
        production_id=record["production_id"],
        shot_id=record["shot_id"],
        provider=record["provider"],
        provider_request_id=record["provider_request_id"],
        operation_key=record["operation_key"] or "",
        reservation_fen=int(record["reservation_fen"]),
        actual_fen=None if record["actual_fen"] is None else int(record["actual_fen"]),
        refunded_fen=int(record["refunded_fen"]),
        status=record["status"],
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _batch(record: Mapping[str, Any] | None) -> BatchRow | None:
    if record is None:
        return None
    return BatchRow(
        output_batch_render_id=record["output_batch_render_id"],
        project_id=record["project_id"],
        batch_id=record["batch_id"],
        content_hash=record["content_hash"],
        render_id=record["render_id"],
        bucket_name=record["bucket_name"],
        status=record["status"],
        url=record["url"],
        checksum=record["checksum"],
        object_key=record["object_key"],
        frame_from=int(record["frame_from"]),
        frame_to=int(record["frame_to"]),
        progress=float(record["progress"]),
        attempt=int(record["attempt"]),
        shot_ids=[str(item) for item in _items(record["shot_ids"])],
        required=bool(record["required"]),
        render_config=_obj(record["render_config"]),
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _outbox(record: Mapping[str, Any] | None) -> OutboxRow:
    assert record is not None
    return OutboxRow(
        event_id=record["event_id"],
        aggregate_id=record["aggregate_id"],
        type=record["type"],
        payload=_obj(record["payload"]),
        available_at=_time(record["available_at"]),
        published_at=_time_opt(record["published_at"]),
        attempt=int(record["attempt"]),
        lease_owner=record["lease_owner"],
        lease_expires_at=_time_opt(record["lease_expires_at"]),
        created_at=_time(record["created_at"]),
    )


def _job(record: Mapping[str, Any] | None) -> JobRow | None:
    if record is None:
        return None
    return JobRow(
        job_key=record["job_key"],
        type=record["type"],
        payload=_obj(record["payload"]),
        status=record["status"],
        attempt=int(record["attempt"]),
        lease_owner=record["lease_owner"],
        lease_expires_at=_time_opt(record["lease_expires_at"]),
        heartbeat_at=_time_opt(record["heartbeat_at"]),
        last_error_code=record["last_error_code"],
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )


def _delivery(record: Mapping[str, Any] | None) -> DeliveryRow | None:
    if record is None:
        return None
    return DeliveryRow(
        delivery_id=record["delivery_id"],
        tenant_id=record["tenant_id"],
        production_id=record["production_id"],
        project_id=record["project_id"],
        package_input_hash=record["package_input_hash"],
        content_hash=record["content_hash"],
        object_key=record["object_key"],
        checksum=record["checksum"],
        size_bytes=int(record["size_bytes"]),
        status=record["status"],
        url_generation=int(record["url_generation"]),
        manifest_json=_obj(record["manifest_json"]),
        play_order=[str(item) for item in _items(record["play_order"])],
        created_at=_time(record["created_at"]),
        revoked_at=_time_opt(record["revoked_at"]),
    )


def _tombstone(record: Mapping[str, Any] | None) -> TombstoneRow | None:
    if record is None:
        return None
    return TombstoneRow(
        tombstone_id=record["tombstone_id"],
        tenant_id=record["tenant_id"],
        object_key=record["object_key"],
        category=record["category"],
        status=record["status"],
        reason=record["reason"],
        retain_until=_time_opt(record["retain_until"]),
        requested_at=_time(record["requested_at"]),
        deleted_at=_time_opt(record["deleted_at"]),
        result=record["result"],
    )


def _alert(record: Mapping[str, Any] | None) -> AlertRow | None:
    if record is None:
        return None
    return AlertRow(
        dedup_key=record["dedup_key"],
        tenant_id=record["tenant_id"],
        production_id=record["production_id"],
        stage=record["stage"],
        error_code=record["error_code"],
        window_start=_time(record["window_start"]),
        status=record["status"],
        summary=record["summary"],
        details=_obj(record["details"]),
        created_at=_time(record["created_at"]),
        updated_at=_time(record["updated_at"]),
    )
