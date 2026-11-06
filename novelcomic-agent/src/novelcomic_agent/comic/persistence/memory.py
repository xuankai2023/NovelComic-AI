"""Transactional in-memory ledger used by tests and the local control plane."""

from __future__ import annotations

import copy
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any

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
    LedgerData,
    OutboxRow,
    ProductionRow,
    ShotBudgetRow,
    TombstoneRow,
    utcnow,
)


class UniqueViolation(Exception):
    """Raised when an insert hits a primary or unique key."""

    def __init__(self, constraint: str) -> None:
        super().__init__(constraint)
        self.constraint = constraint


def artifact_identity(row: ArtifactRow) -> tuple[str, str, str, str]:
    return (row.project_id, row.stage, row.input_hash, row.shot_id or "")


class MemorySession:
    """Mutates one ledger snapshot. The caller holds the ledger lock."""

    def __init__(self, data: LedgerData, clock: Callable[[], datetime]) -> None:
        self._data = data
        self._clock = clock

    async def get_production(self, production_id: str) -> ProductionRow | None:
        return _copy(self._data.productions.get(production_id))

    async def find_production_by_request(
        self,
        tenant_id: str,
        request_id: str,
    ) -> ProductionRow | None:
        found = self._data.idempotency.get((tenant_id, request_id))
        if found is None:
            return None
        return await self.get_production(found.production_id)

    async def insert_production(self, row: ProductionRow) -> None:
        if row.production_id in self._data.productions:
            raise UniqueViolation("productions_pkey")
        if any(item.project_id == row.project_id for item in self._data.productions.values()):
            raise UniqueViolation("productions_project_id_key")
        self._data.productions[row.production_id] = _copy(row)

    async def insert_idempotency(self, row: IdempotencyRow) -> None:
        key = (row.tenant_id, row.request_id)
        if key in self._data.idempotency:
            raise UniqueViolation("idempotency_keys_tenant_request_key")
        self._data.idempotency[key] = _copy(row)

    async def save_production(
        self,
        row: ProductionRow,
        *,
        expected_version: int,
    ) -> ProductionRow | None:
        current = self._data.productions.get(row.production_id)
        if current is None or current.version != expected_version:
            return None
        if current.tenant_id != row.tenant_id or current.project_id != row.project_id:
            return None
        stored = _copy(row)
        stored.version = expected_version + 1
        stored.updated_at = self._clock()
        self._data.productions[row.production_id] = stored
        return _copy(stored)

    async def insert_draft(self, row: DraftRow) -> None:
        if row.project_id in self._data.drafts:
            raise UniqueViolation("drafts_pkey")
        self._data.drafts[row.project_id] = _copy(row)

    async def insert_draft_revision(self, row: DraftRevisionRow) -> None:
        key = (row.project_id, row.revision)
        if key in self._data.draft_revisions:
            raise UniqueViolation("draft_revisions_pkey")
        self._data.draft_revisions[key] = _copy(row)

    async def get_draft(self, project_id: str) -> DraftRow | None:
        return _copy(self._data.drafts.get(project_id))

    async def get_draft_revision(
        self,
        project_id: str,
        revision: int,
    ) -> DraftRevisionRow | None:
        return _copy(self._data.draft_revisions.get((project_id, revision)))

    async def get_command(self, command_id: str) -> CommandRow | None:
        return _copy(self._data.commands.get(command_id))

    async def find_command_by_ordinal(
        self,
        project_id: str,
        ordinal: int,
    ) -> CommandRow | None:
        command_id = self._data.command_ordinals.get((project_id, ordinal))
        if command_id is None:
            return None
        return await self.get_command(command_id)

    async def insert_command(self, row: CommandRow) -> None:
        if row.command_id in self._data.commands:
            raise UniqueViolation("compose_commands_pkey")
        ordinal_key = (row.project_id, row.ordinal)
        if ordinal_key in self._data.command_ordinals:
            raise UniqueViolation("compose_commands_project_ordinal_key")
        self._data.commands[row.command_id] = _copy(row)
        self._data.command_ordinals[ordinal_key] = row.command_id

    async def save_command(self, row: CommandRow) -> None:
        current = self._data.commands.get(row.command_id)
        if current is None:
            raise KeyError(row.command_id)
        if current.project_id != row.project_id or current.ordinal != row.ordinal:
            raise UniqueViolation("compose_commands_identity")
        stored = _copy(row)
        stored.updated_at = self._clock()
        self._data.commands[row.command_id] = stored

    async def commit_draft(
        self,
        *,
        command_id: str,
        project_id: str,
        expected_revision: int,
        new_project: dict[str, Any],
        new_content_hash: str,
    ) -> int | None:
        draft = self._data.drafts.get(project_id)
        command = self._data.commands.get(command_id)
        if (
            draft is None
            or command is None
            or command.project_id != project_id
            or command.status != "running"
            or draft.revision != expected_revision
            or command.expected_revision != expected_revision
        ):
            return None
        now = self._clock()
        new_revision = draft.revision + 1
        draft.revision = new_revision
        draft.project_json = _copy(new_project)
        draft.content_hash = new_content_hash
        draft.updated_at = now
        self._data.draft_revisions[(project_id, new_revision)] = DraftRevisionRow(
            project_id=project_id,
            revision=new_revision,
            project_json=_copy(new_project),
            content_hash=new_content_hash,
            command_id=command_id,
            created_at=now,
        )
        command.status = "committed"
        command.resulting_revision = new_revision
        command.updated_at = now
        command.last_error_code = None
        return new_revision

    async def get_artifact(self, artifact_id: str) -> ArtifactRow | None:
        return _copy(self._data.artifacts.get(artifact_id))

    async def find_artifact(
        self,
        *,
        project_id: str,
        stage: str,
        input_hash: str,
        shot_id: str | None,
    ) -> ArtifactRow | None:
        artifact_id = self._data.artifact_keys.get(
            (project_id, stage, input_hash, shot_id or "")
        )
        if artifact_id is None:
            return None
        return await self.get_artifact(artifact_id)

    async def find_tenant_artifact(
        self,
        *,
        tenant_id: str,
        stage: str,
        input_hash: str,
    ) -> ArtifactRow | None:
        matches = [
            row
            for row in self._data.artifacts.values()
            if row.tenant_id == tenant_id
            and row.stage == stage
            and row.input_hash == input_hash
            and row.status == "completed"
        ]
        if not matches:
            return None
        matches.sort(key=lambda row: (row.created_at, row.artifact_id))
        return _copy(matches[0])

    async def insert_artifact(self, row: ArtifactRow) -> None:
        if row.artifact_id in self._data.artifacts:
            raise UniqueViolation("asset_artifacts_pkey")
        key = artifact_identity(row)
        if key in self._data.artifact_keys:
            raise UniqueViolation("asset_artifacts_reuse_key")
        self._data.artifacts[row.artifact_id] = _copy(row)
        self._data.artifact_keys[key] = row.artifact_id

    async def save_artifact(self, row: ArtifactRow) -> None:
        current = self._data.artifacts.get(row.artifact_id)
        if current is None:
            raise KeyError(row.artifact_id)
        if artifact_identity(current) != artifact_identity(row):
            raise UniqueViolation("asset_artifacts_reuse_key")
        if current.tenant_id != row.tenant_id:
            raise UniqueViolation("asset_artifacts_tenant")
        stored = _copy(row)
        stored.updated_at = self._clock()
        self._data.artifacts[row.artifact_id] = stored

    async def get_cost(self, cost_entry_id: str) -> CostRow | None:
        return _copy(self._data.costs.get(cost_entry_id))

    async def find_cost_by_operation(
        self,
        production_id: str,
        operation_key: str,
    ) -> CostRow | None:
        cost_id = self._data.cost_operations.get((production_id, operation_key))
        if cost_id is None:
            return None
        return await self.get_cost(cost_id)

    async def find_cost_by_provider_request(self, provider_request_id: str) -> CostRow | None:
        cost_id = self._data.cost_provider_requests.get(provider_request_id)
        if cost_id is None:
            return None
        return await self.get_cost(cost_id)

    async def list_costs(self, production_id: str) -> list[CostRow]:
        rows = [row for row in self._data.costs.values() if row.production_id == production_id]
        rows.sort(key=lambda row: row.created_at)
        return [_copy(row) for row in rows]

    async def insert_cost(self, row: CostRow) -> None:
        if row.cost_entry_id in self._data.costs:
            raise UniqueViolation("cost_entries_pkey")
        operation_key = (row.production_id, row.operation_key)
        if operation_key in self._data.cost_operations:
            raise UniqueViolation("cost_entries_operation_key_unique")
        if row.provider_request_id:
            if row.provider_request_id in self._data.cost_provider_requests:
                raise UniqueViolation("cost_entries_provider_request_unique")
            self._data.cost_provider_requests[row.provider_request_id] = row.cost_entry_id
        self._data.costs[row.cost_entry_id] = _copy(row)
        self._data.cost_operations[operation_key] = row.cost_entry_id

    async def save_cost(self, row: CostRow) -> None:
        current = self._data.costs.get(row.cost_entry_id)
        if current is None:
            raise KeyError(row.cost_entry_id)
        if current.production_id != row.production_id or current.operation_key != row.operation_key:
            raise UniqueViolation("cost_entries_operation_key_unique")
        if row.provider_request_id != current.provider_request_id:
            if current.provider_request_id:
                self._data.cost_provider_requests.pop(current.provider_request_id, None)
            if row.provider_request_id:
                holder = self._data.cost_provider_requests.get(row.provider_request_id)
                if holder is not None and holder != row.cost_entry_id:
                    raise UniqueViolation("cost_entries_provider_request_unique")
                self._data.cost_provider_requests[row.provider_request_id] = row.cost_entry_id
        stored = _copy(row)
        stored.updated_at = self._clock()
        self._data.costs[row.cost_entry_id] = stored

    async def get_shot_budget(self, production_id: str, shot_id: str) -> ShotBudgetRow | None:
        return _copy(self._data.shot_budgets.get((production_id, shot_id)))

    async def save_shot_budget(self, row: ShotBudgetRow) -> None:
        self._data.shot_budgets[(row.production_id, row.shot_id)] = _copy(row)

    async def get_batch(self, output_batch_render_id: str) -> BatchRow | None:
        return _copy(self._data.batches.get(output_batch_render_id))

    async def find_batch(
        self,
        *,
        project_id: str,
        batch_id: str,
        content_hash: str,
    ) -> BatchRow | None:
        batch_key = self._data.batch_keys.get((project_id, batch_id, content_hash))
        if batch_key is None:
            return None
        return await self.get_batch(batch_key)

    async def list_batches(
        self,
        project_id: str,
        content_hash: str | None = None,
    ) -> list[BatchRow]:
        rows = [
            row
            for row in self._data.batches.values()
            if row.project_id == project_id
            and (content_hash is None or row.content_hash == content_hash)
        ]
        rows.sort(key=lambda row: (row.frame_from, row.batch_id))
        return [_copy(row) for row in rows]

    async def insert_batch(self, row: BatchRow) -> None:
        if row.output_batch_render_id in self._data.batches:
            raise UniqueViolation("output_batch_renders_pkey")
        key = (row.project_id, row.batch_id, row.content_hash)
        if key in self._data.batch_keys:
            raise UniqueViolation("output_batch_renders_project_batch_hash_key")
        self._data.batches[row.output_batch_render_id] = _copy(row)
        self._data.batch_keys[key] = row.output_batch_render_id

    async def save_batch(self, row: BatchRow) -> None:
        current = self._data.batches.get(row.output_batch_render_id)
        if current is None:
            raise KeyError(row.output_batch_render_id)
        if (
            current.project_id != row.project_id
            or current.batch_id != row.batch_id
            or current.content_hash != row.content_hash
        ):
            raise UniqueViolation("output_batch_renders_project_batch_hash_key")
        stored = _copy(row)
        stored.updated_at = self._clock()
        self._data.batches[row.output_batch_render_id] = stored

    async def insert_outbox(self, row: OutboxRow) -> None:
        if row.event_id in self._data.outbox:
            raise UniqueViolation("outbox_events_pkey")
        self._data.outbox[row.event_id] = _copy(row)

    async def list_outbox(self) -> list[OutboxRow]:
        rows = list(self._data.outbox.values())
        rows.sort(key=lambda row: (row.created_at, row.event_id))
        return [_copy(row) for row in rows]

    async def claim_outbox(self, *, owner: str, limit: int, lease_seconds: int) -> list[OutboxRow]:
        now = self._clock()
        available = [
            row
            for row in self._data.outbox.values()
            if row.published_at is None
            and row.available_at <= now
            and _lease_free(row.lease_expires_at, now)
        ]
        available.sort(key=lambda row: (row.available_at, row.created_at, row.event_id))
        claimed: list[OutboxRow] = []
        for row in available[:limit]:
            row.lease_owner = owner
            row.lease_expires_at = now + timedelta(seconds=lease_seconds)
            row.attempt += 1
            claimed.append(_copy(row))
        return claimed

    async def mark_outbox_published(self, event_id: str, owner: str) -> bool:
        row = self._data.outbox.get(event_id)
        now = self._clock()
        if row is None or row.published_at is not None or row.lease_owner != owner:
            return False
        if not _lease_held(row.lease_expires_at, now):
            return False
        row.published_at = now
        row.lease_owner = None
        row.lease_expires_at = None
        return True

    async def release_outbox(
        self,
        event_id: str,
        owner: str,
        available_at: datetime,
    ) -> bool:
        row = self._data.outbox.get(event_id)
        if row is None or row.published_at is not None or row.lease_owner != owner:
            return False
        row.lease_owner = None
        row.lease_expires_at = None
        row.available_at = available_at
        return True

    async def insert_job(self, row: JobRow) -> None:
        if row.job_key in self._data.jobs:
            raise UniqueViolation("worker_jobs_pkey")
        self._data.jobs[row.job_key] = _copy(row)

    async def claim_job(self, *, job_type: str, owner: str, lease_seconds: int) -> JobRow | None:
        now = self._clock()
        candidates = [
            row
            for row in self._data.jobs.values()
            if row.type == job_type
            and row.status in {"pending", "running"}
            and (row.status == "pending" or _lease_free(row.lease_expires_at, now))
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda row: (row.created_at, row.job_key))
        row = candidates[0]
        row.status = "running"
        row.lease_owner = owner
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        row.heartbeat_at = now
        row.attempt += 1
        row.updated_at = now
        return _copy(row)

    async def heartbeat_job(self, *, job_key: str, owner: str, lease_seconds: int) -> bool:
        row = self._owned_live_job(job_key, owner)
        if row is None:
            return False
        now = self._clock()
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        row.heartbeat_at = now
        row.updated_at = now
        return True

    async def complete_job(self, *, job_key: str, owner: str) -> bool:
        row = self._owned_live_job(job_key, owner)
        if row is None:
            return False
        now = self._clock()
        row.status = "completed"
        row.lease_owner = None
        row.lease_expires_at = None
        row.updated_at = now
        return True

    async def fail_job(self, *, job_key: str, owner: str, error_code: str) -> bool:
        row = self._owned_live_job(job_key, owner)
        if row is None:
            return False
        now = self._clock()
        row.status = "failed"
        row.last_error_code = error_code
        row.lease_owner = None
        row.lease_expires_at = None
        row.updated_at = now
        return True

    async def get_job(self, job_key: str) -> JobRow | None:
        return _copy(self._data.jobs.get(job_key))

    async def list_artifacts(self, project_id: str) -> list[ArtifactRow]:
        rows = [row for row in self._data.artifacts.values() if row.project_id == project_id]
        rows.sort(key=lambda row: (row.stage, row.artifact_id))
        return [_copy(row) for row in rows]

    async def insert_delivery(self, row: DeliveryRow) -> None:
        if row.delivery_id in self._data.deliveries:
            raise UniqueViolation("deliveries_pkey")
        key = (row.production_id, row.package_input_hash)
        if key in self._data.delivery_keys:
            raise UniqueViolation("deliveries_production_hash_key")
        self._data.deliveries[row.delivery_id] = _copy(row)
        self._data.delivery_keys[key] = row.delivery_id

    async def find_delivery(
        self, production_id: str, package_input_hash: str
    ) -> DeliveryRow | None:
        delivery_id = self._data.delivery_keys.get((production_id, package_input_hash))
        if delivery_id is None:
            return None
        return _copy(self._data.deliveries.get(delivery_id))

    async def list_deliveries(self, production_id: str | None = None) -> list[DeliveryRow]:
        rows = [
            row
            for row in self._data.deliveries.values()
            if production_id is None or row.production_id == production_id
        ]
        rows.sort(key=lambda row: (row.created_at, row.delivery_id))
        return [_copy(row) for row in rows]

    async def save_delivery(self, row: DeliveryRow) -> None:
        current = self._data.deliveries.get(row.delivery_id)
        if current is None:
            raise KeyError(row.delivery_id)
        self._data.deliveries[row.delivery_id] = _copy(row)

    async def insert_tombstone(self, row: TombstoneRow) -> None:
        if row.tombstone_id in self._data.tombstones:
            raise UniqueViolation("tombstones_pkey")
        key = (row.tenant_id, row.object_key)
        if key in self._data.tombstone_keys:
            raise UniqueViolation("tombstones_tenant_object_key")
        self._data.tombstones[row.tombstone_id] = _copy(row)
        self._data.tombstone_keys[key] = row.tombstone_id

    async def get_tombstone(self, tombstone_id: str) -> TombstoneRow | None:
        return _copy(self._data.tombstones.get(tombstone_id))

    async def find_tombstone(self, tenant_id: str, object_key: str) -> TombstoneRow | None:
        tombstone_id = self._data.tombstone_keys.get((tenant_id, object_key))
        if tombstone_id is None:
            return None
        return await self.get_tombstone(tombstone_id)

    async def save_tombstone(self, row: TombstoneRow) -> None:
        if row.tombstone_id not in self._data.tombstones:
            raise KeyError(row.tombstone_id)
        self._data.tombstones[row.tombstone_id] = _copy(row)

    async def insert_alert(self, row: AlertRow) -> None:
        if row.dedup_key in self._data.alerts:
            raise UniqueViolation("alerts_pkey")
        self._data.alerts[row.dedup_key] = _copy(row)

    async def get_alert(self, dedup_key: str) -> AlertRow | None:
        return _copy(self._data.alerts.get(dedup_key))

    async def save_alert(self, row: AlertRow) -> None:
        if row.dedup_key not in self._data.alerts:
            raise KeyError(row.dedup_key)
        stored = _copy(row)
        stored.updated_at = self._clock()
        self._data.alerts[row.dedup_key] = stored

    def _owned_live_job(self, job_key: str, owner: str) -> JobRow | None:
        row = self._data.jobs.get(job_key)
        if row is None or row.status != "running" or row.lease_owner != owner:
            return None
        if not _lease_held(row.lease_expires_at, self._clock()):
            return None
        return row


class MemoryLedger:
    """Serialize transactions and roll back the snapshot when a transaction raises."""

    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self._data = LedgerData()
        self._clock = clock or utcnow
        self._lock = _Lock()

    @asynccontextmanager
    async def transaction(self) -> Any:
        async with self._lock:
            snapshot = copy.deepcopy(self._data)
            session = MemorySession(self._data, self._clock)
            try:
                yield session
            except Exception:
                self._data = snapshot
                raise


class _Lock:
    """Lazy asyncio lock so the ledger can be constructed outside a running loop."""

    def __init__(self) -> None:
        self._lock: Any = None

    async def __aenter__(self) -> None:
        import asyncio

        if self._lock is None:
            self._lock = asyncio.Lock()
        await self._lock.acquire()

    async def __aexit__(self, *exc: object) -> None:
        self._lock.release()


def _copy(value: Any) -> Any:
    if value is None:
        return None
    return copy.deepcopy(value)


def _lease_free(expires_at: datetime | None, now: datetime) -> bool:
    return expires_at is None or expires_at <= now


def _lease_held(expires_at: datetime | None, now: datetime) -> bool:
    return expires_at is not None and expires_at > now
