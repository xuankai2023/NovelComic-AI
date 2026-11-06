"""Ledger protocol shared by the in-memory and PostgreSQL control planes."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from datetime import datetime
from typing import Any, Protocol

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
)


class LedgerSession(Protocol):
    """Session methods already used by the comic repositories."""

    async def get_production(self, production_id: str) -> ProductionRow | None: ...

    async def find_production_by_request(
        self,
        tenant_id: str,
        request_id: str,
    ) -> ProductionRow | None: ...

    async def insert_production(self, row: ProductionRow) -> None: ...

    async def insert_idempotency(self, row: IdempotencyRow) -> None: ...

    async def save_production(
        self,
        row: ProductionRow,
        *,
        expected_version: int,
    ) -> ProductionRow | None: ...

    async def insert_draft(self, row: DraftRow) -> None: ...

    async def insert_draft_revision(self, row: DraftRevisionRow) -> None: ...

    async def get_draft(self, project_id: str) -> DraftRow | None: ...

    async def get_draft_revision(
        self,
        project_id: str,
        revision: int,
    ) -> DraftRevisionRow | None: ...

    async def get_command(self, command_id: str) -> CommandRow | None: ...

    async def find_command_by_ordinal(
        self,
        project_id: str,
        ordinal: int,
    ) -> CommandRow | None: ...

    async def insert_command(self, row: CommandRow) -> None: ...

    async def save_command(self, row: CommandRow) -> None: ...

    async def commit_draft(
        self,
        *,
        command_id: str,
        project_id: str,
        expected_revision: int,
        new_project: dict[str, Any],
        new_content_hash: str,
    ) -> int | None: ...

    async def get_artifact(self, artifact_id: str) -> ArtifactRow | None: ...

    async def find_artifact(
        self,
        *,
        project_id: str,
        stage: str,
        input_hash: str,
        shot_id: str | None,
    ) -> ArtifactRow | None: ...

    async def find_tenant_artifact(
        self,
        *,
        tenant_id: str,
        stage: str,
        input_hash: str,
    ) -> ArtifactRow | None: ...

    async def insert_artifact(self, row: ArtifactRow) -> None: ...

    async def save_artifact(self, row: ArtifactRow) -> None: ...

    async def get_cost(self, cost_entry_id: str) -> CostRow | None: ...

    async def find_cost_by_operation(
        self,
        production_id: str,
        operation_key: str,
    ) -> CostRow | None: ...

    async def find_cost_by_provider_request(self, provider_request_id: str) -> CostRow | None: ...

    async def list_costs(self, production_id: str) -> list[CostRow]: ...

    async def insert_cost(self, row: CostRow) -> None: ...

    async def save_cost(self, row: CostRow) -> None: ...

    async def get_shot_budget(self, production_id: str, shot_id: str) -> ShotBudgetRow | None: ...

    async def save_shot_budget(self, row: ShotBudgetRow) -> None: ...

    async def get_batch(self, output_batch_render_id: str) -> BatchRow | None: ...

    async def find_batch(
        self,
        *,
        project_id: str,
        batch_id: str,
        content_hash: str,
    ) -> BatchRow | None: ...

    async def list_batches(
        self,
        project_id: str,
        content_hash: str | None = None,
    ) -> list[BatchRow]: ...

    async def insert_batch(self, row: BatchRow) -> None: ...

    async def save_batch(self, row: BatchRow) -> None: ...

    async def insert_outbox(self, row: OutboxRow) -> None: ...

    async def list_outbox(self) -> list[OutboxRow]: ...

    async def claim_outbox(
        self, *, owner: str, limit: int, lease_seconds: int
    ) -> list[OutboxRow]: ...

    async def mark_outbox_published(self, event_id: str, owner: str) -> bool: ...

    async def release_outbox(
        self,
        event_id: str,
        owner: str,
        available_at: datetime,
    ) -> bool: ...

    async def insert_job(self, row: JobRow) -> None: ...

    async def claim_job(
        self, *, job_type: str, owner: str, lease_seconds: int
    ) -> JobRow | None: ...

    async def heartbeat_job(self, *, job_key: str, owner: str, lease_seconds: int) -> bool: ...

    async def complete_job(self, *, job_key: str, owner: str) -> bool: ...

    async def fail_job(self, *, job_key: str, owner: str, error_code: str) -> bool: ...

    async def get_job(self, job_key: str) -> JobRow | None: ...

    async def list_artifacts(self, project_id: str) -> list[ArtifactRow]: ...

    async def insert_delivery(self, row: DeliveryRow) -> None: ...

    async def find_delivery(
        self, production_id: str, package_input_hash: str
    ) -> DeliveryRow | None: ...

    async def list_deliveries(self, production_id: str | None = None) -> list[DeliveryRow]: ...

    async def save_delivery(self, row: DeliveryRow) -> None: ...

    async def insert_tombstone(self, row: TombstoneRow) -> None: ...

    async def get_tombstone(self, tombstone_id: str) -> TombstoneRow | None: ...

    async def find_tombstone(self, tenant_id: str, object_key: str) -> TombstoneRow | None: ...

    async def save_tombstone(self, row: TombstoneRow) -> None: ...

    async def insert_alert(self, row: AlertRow) -> None: ...

    async def get_alert(self, dedup_key: str) -> AlertRow | None: ...

    async def save_alert(self, row: AlertRow) -> None: ...


class Ledger(Protocol):
    """One transaction yields one session and rolls back when the body raises."""

    def transaction(self) -> AbstractAsyncContextManager[LedgerSession]: ...
