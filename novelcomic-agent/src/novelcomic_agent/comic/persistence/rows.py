"""In-memory rows for the comic control-plane ledger."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


def utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class ProductionRow:
    production_id: str
    project_id: str
    tenant_id: str
    state: str
    phase: str
    version: int
    fixing_count: int
    cancel_requested_at: datetime | None
    budget_limit_fen: int
    shot_limit_fen: int
    max_paid_calls_per_shot: int
    reserved_cost_fen: int
    actual_cost_fen: int
    can_produce_playable: bool
    degraded: bool
    last_error_code: str | None
    last_error_message: str | None
    request_hash: str
    request_json: dict[str, Any]
    stage_facts: dict[str, Any]
    created_at: datetime
    updated_at: datetime


@dataclass
class IdempotencyRow:
    tenant_id: str
    request_id: str
    payload_hash: str
    production_id: str
    created_at: datetime


@dataclass
class DraftRow:
    project_id: str
    revision: int
    project_json: dict[str, Any]
    content_hash: str
    created_at: datetime
    updated_at: datetime


@dataclass
class DraftRevisionRow:
    project_id: str
    revision: int
    project_json: dict[str, Any]
    content_hash: str
    command_id: str | None
    created_at: datetime


@dataclass
class CommandRow:
    command_id: str
    project_id: str
    ordinal: int
    name: str
    input_hash: str
    expected_revision: int
    resulting_revision: int | None
    status: str
    attempt: int
    last_error_code: str | None
    created_at: datetime
    updated_at: datetime


@dataclass
class ArtifactRow:
    artifact_id: str
    tenant_id: str
    project_id: str
    shot_id: str | None
    stage: str
    input_hash: str
    provider: str
    provider_request_id: str | None
    status: str
    urls: list[str]
    checksums: list[str]
    diagnostics: dict[str, Any]
    cost_fen: int
    attempt: int
    created_at: datetime
    updated_at: datetime


@dataclass
class CostRow:
    cost_entry_id: str
    production_id: str
    shot_id: str | None
    provider: str
    provider_request_id: str | None
    operation_key: str
    reservation_fen: int
    actual_fen: int | None
    refunded_fen: int
    status: str
    created_at: datetime
    updated_at: datetime


@dataclass
class ShotBudgetRow:
    production_id: str
    shot_id: str
    reserved_fen: int = 0
    actual_fen: int = 0
    paid_calls: int = 0


@dataclass
class BatchRow:
    output_batch_render_id: str
    project_id: str
    batch_id: str
    content_hash: str
    render_id: str | None
    bucket_name: str | None
    status: str
    url: str | None
    checksum: str | None
    object_key: str | None
    frame_from: int
    frame_to: int
    progress: float
    attempt: int
    shot_ids: list[str]
    required: bool
    render_config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


@dataclass
class OutboxRow:
    event_id: str
    aggregate_id: str
    type: str
    payload: dict[str, Any]
    available_at: datetime
    published_at: datetime | None
    attempt: int
    lease_owner: str | None
    lease_expires_at: datetime | None
    created_at: datetime


@dataclass
class JobRow:
    job_key: str
    type: str
    payload: dict[str, Any]
    status: str
    attempt: int
    lease_owner: str | None
    lease_expires_at: datetime | None
    heartbeat_at: datetime | None
    last_error_code: str | None
    created_at: datetime
    updated_at: datetime


@dataclass
class DeliveryRow:
    delivery_id: str
    tenant_id: str
    production_id: str
    project_id: str
    package_input_hash: str
    content_hash: str
    object_key: str
    checksum: str
    size_bytes: int
    status: str
    url_generation: int
    manifest_json: dict[str, Any]
    play_order: list[str]
    created_at: datetime
    revoked_at: datetime | None


@dataclass
class TombstoneRow:
    tombstone_id: str
    tenant_id: str
    object_key: str
    category: str
    status: str
    reason: str
    retain_until: datetime | None
    requested_at: datetime
    deleted_at: datetime | None
    result: str | None


@dataclass
class AlertRow:
    dedup_key: str
    tenant_id: str
    production_id: str | None
    stage: str
    error_code: str
    window_start: datetime
    status: str
    summary: str
    details: dict[str, Any]
    created_at: datetime
    updated_at: datetime


@dataclass
class LedgerData:
    productions: dict[str, ProductionRow] = field(default_factory=dict)
    idempotency: dict[tuple[str, str], IdempotencyRow] = field(default_factory=dict)
    drafts: dict[str, DraftRow] = field(default_factory=dict)
    draft_revisions: dict[tuple[str, int], DraftRevisionRow] = field(default_factory=dict)
    commands: dict[str, CommandRow] = field(default_factory=dict)
    command_ordinals: dict[tuple[str, int], str] = field(default_factory=dict)
    artifacts: dict[str, ArtifactRow] = field(default_factory=dict)
    artifact_keys: dict[tuple[str, str, str, str], str] = field(default_factory=dict)
    costs: dict[str, CostRow] = field(default_factory=dict)
    cost_operations: dict[tuple[str, str], str] = field(default_factory=dict)
    cost_provider_requests: dict[str, str] = field(default_factory=dict)
    shot_budgets: dict[tuple[str, str], ShotBudgetRow] = field(default_factory=dict)
    batches: dict[str, BatchRow] = field(default_factory=dict)
    batch_keys: dict[tuple[str, str, str], str] = field(default_factory=dict)
    outbox: dict[str, OutboxRow] = field(default_factory=dict)
    jobs: dict[str, JobRow] = field(default_factory=dict)
    deliveries: dict[str, DeliveryRow] = field(default_factory=dict)
    delivery_keys: dict[tuple[str, str], str] = field(default_factory=dict)
    tombstones: dict[str, TombstoneRow] = field(default_factory=dict)
    tombstone_keys: dict[tuple[str, str], str] = field(default_factory=dict)
    alerts: dict[str, AlertRow] = field(default_factory=dict)
