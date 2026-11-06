"""Production acceptance, tenant reads, cancellation, and state CAS."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import uuid4

from ..canonical import hash_content
from ..contracts.errors import ComicServiceError
from ..contracts.production_request import ProductionRequest
from ..persistence.ledger import Ledger, LedgerSession
from ..persistence.memory import UniqueViolation
from ..persistence.rows import (
    DeliveryRow,
    DraftRevisionRow,
    DraftRow,
    IdempotencyRow,
    OutboxRow,
    ProductionRow,
    utcnow,
)
from ..units import rmb_to_fen
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import (
    TERMINAL_STATES,
    ProductionState,
    TransitionGuard,
    assert_transition_allowed,
)
from .budget_updates import release_open_reservations


@dataclass(frozen=True, slots=True)
class AcceptedProduction:
    production_id: str
    project_id: str
    state: ProductionState
    version: int
    replayed: bool
    request_hash: str


class ProductionNotFoundError(ComicServiceError):
    """Raised when the production is missing or belongs to another tenant."""

    def __init__(self, production_id: str) -> None:
        super().__init__(
            "INVALID_REQUEST",
            "production was not found",
            retryable=False,
            details={"productionId": production_id},
        )


class ProductionRepository:
    """Tenant-scoped production facts. State changes share a transaction with outbox."""

    def __init__(self, ledger: Ledger, clock: Any | None = None) -> None:
        self._ledger = ledger
        self._clock = clock or utcnow

    async def accept(
        self,
        *,
        tenant_id: str,
        request: ProductionRequest,
        project: dict[str, Any],
        content_hash: str,
        production_id: str,
        project_id: str,
        phase: str = "B",
    ) -> AcceptedProduction:
        if phase not in {"B", "E"}:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "production phase is not supported",
                retryable=False,
            )
        payload_hash = hash_content(request.model_dump(mode="json", by_alias=True))
        try:
            async with self._ledger.transaction() as session:
                await _insert_acceptance(
                    session,
                    tenant_id=tenant_id,
                    request=request,
                    payload_hash=payload_hash,
                    project=project,
                    content_hash=content_hash,
                    production_id=production_id,
                    project_id=project_id,
                    phase=phase,
                    now=self._clock(),
                )
        except UniqueViolation as exc:
            if exc.constraint != "idempotency_keys_tenant_request_key":
                raise
            return await self._replay(tenant_id, request.prod_client_request_id, payload_hash)
        return AcceptedProduction(
            production_id=production_id,
            project_id=project_id,
            state=ProductionState.CREATED,
            version=0,
            replayed=False,
            request_hash=payload_hash,
        )

    async def find_by_request(self, tenant_id: str, request_id: str) -> ProductionRow | None:
        async with self._ledger.transaction() as session:
            return await session.find_production_by_request(tenant_id, request_id)

    async def get(self, production_id: str) -> ProductionSnapshot:
        row = await self._require(production_id)
        return _snapshot(row)

    async def get_row(self, production_id: str) -> ProductionRow:
        return await self._require(production_id)

    async def get_for_tenant(self, tenant_id: str, production_id: str) -> ProductionRow | None:
        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
        if row is None or row.tenant_id != tenant_id:
            return None
        return row

    async def transition_with_outbox(
        self,
        *,
        production_id: str,
        expected_state: ProductionState,
        expected_version: int,
        next_state: ProductionState,
        increment_fixing_count: bool,
        event_type: str,
        event_payload: dict[str, Any],
    ) -> ProductionSnapshot:
        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
            saved = await _write_transition(
                session,
                row=row,
                expected_state=expected_state,
                expected_version=expected_version,
                next_state=next_state,
                increment_fixing_count=increment_fixing_count,
                event_type=event_type,
                event_payload=event_payload,
                now=self._clock(),
            )
        return _snapshot(saved)

    async def advance(
        self,
        *,
        production_id: str,
        expected_state: ProductionState,
        expected_version: int,
        next_state: ProductionState,
        completion_fact: dict[str, Any],
        can_produce_playable: bool,
        degraded: bool = False,
    ) -> ProductionSnapshot:
        """Commit the finished stage fact, the next state, and its outbox together."""

        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
            if row is None:
                raise _missing(production_id)
            if row.state == next_state.value and expected_state.value in row.stage_facts:
                return _snapshot(row)
            if row.cancel_requested_at is not None:
                raise ComicServiceError(
                    "PRODUCTION_CANCELLED",
                    "production is cancelled",
                    retryable=False,
                )
            guard = TransitionGuard(
                phase=row.phase,  # type: ignore[arg-type]
                fixing_count=row.fixing_count,
                can_produce_playable=can_produce_playable or row.can_produce_playable,
                completion_facts_satisfied=True,
            )
            assert_transition_allowed(ProductionState(row.state), next_state, guard)
            if row.state != expected_state.value or row.version != expected_version:
                raise _stale(production_id)
            facts = dict(row.stage_facts)
            facts[expected_state.value] = completion_fact
            row.stage_facts = facts
            row.can_produce_playable = row.can_produce_playable or can_produce_playable
            row.degraded = row.degraded or degraded
            saved = await _write_transition(
                session,
                row=row,
                expected_state=expected_state,
                expected_version=expected_version,
                next_state=next_state,
                increment_fixing_count=next_state is ProductionState.FIXING,
                event_type="production.state.changed",
                event_payload={
                    "productionId": production_id,
                    "previousState": expected_state.value,
                    "state": next_state.value,
                    "worker": _worker_for(next_state),
                },
                now=self._clock(),
                already_checked=True,
            )
        return _snapshot(saved)

    async def complete_packaging(
        self,
        *,
        production_id: str,
        expected_version: int,
        delivery: DeliveryRow,
    ) -> ProductionSnapshot:
        """Commit the delivery row and DELIVERED in one transaction."""

        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
            if row is None:
                raise _missing(production_id)
            if row.tenant_id != delivery.tenant_id or row.project_id != delivery.project_id:
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "delivery tenant does not match the production",
                    retryable=False,
                )
            existing = await session.find_delivery(production_id, delivery.package_input_hash)
            if existing is None:
                await session.insert_delivery(delivery)
            elif (
                existing.checksum != delivery.checksum or existing.object_key != delivery.object_key
            ):
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "package input hash already has different bytes",
                    retryable=False,
                )
            if row.state == ProductionState.DELIVERED.value:
                return _snapshot(row)
            if row.state != ProductionState.PACKAGING.value or row.version != expected_version:
                raise _stale(production_id)
            assert_transition_allowed(
                ProductionState.PACKAGING,
                ProductionState.DELIVERED,
                TransitionGuard(
                    phase=row.phase,  # type: ignore[arg-type]
                    fixing_count=row.fixing_count,
                    can_produce_playable=True,
                    completion_facts_satisfied=True,
                ),
            )
            facts = dict(row.stage_facts)
            facts[ProductionState.PACKAGING.value] = {
                "packageInputHash": delivery.package_input_hash,
                "objectKey": delivery.object_key,
                "checksum": delivery.checksum,
                "sizeBytes": delivery.size_bytes,
                "contentHash": delivery.content_hash,
            }
            row.stage_facts = facts
            saved = await _write_transition(
                session,
                row=row,
                expected_state=ProductionState.PACKAGING,
                expected_version=expected_version,
                next_state=ProductionState.DELIVERED,
                increment_fixing_count=False,
                event_type="production.state.changed",
                event_payload={
                    "productionId": production_id,
                    "previousState": ProductionState.PACKAGING.value,
                    "state": ProductionState.DELIVERED.value,
                    "worker": "package",
                },
                now=self._clock(),
                already_checked=True,
            )
        return _snapshot(saved)

    async def cancel(
        self,
        *,
        tenant_id: str,
        production_id: str,
        actor: str,
    ) -> ProductionRow:
        if actor not in {"user", "admin"}:
            raise ComicServiceError(
                "STAGE_GUARD_REJECTED",
                "only a user or administrator may cancel a production",
                retryable=False,
            )
        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
            if row is None or row.tenant_id != tenant_id:
                raise ProductionNotFoundError(production_id)
            current = ProductionState(row.state)
            assert_transition_allowed(
                current,
                ProductionState.CANCELLED,
                TransitionGuard(
                    phase=row.phase,  # type: ignore[arg-type]
                    fixing_count=row.fixing_count,
                    can_produce_playable=row.can_produce_playable,
                    cancellation_actor=actor,  # type: ignore[arg-type]
                ),
            )
            await release_open_reservations(session, row)
            row.cancel_requested_at = self._clock()
            saved = await _write_transition(
                session,
                row=row,
                expected_state=current,
                expected_version=row.version,
                next_state=ProductionState.CANCELLED,
                increment_fixing_count=False,
                event_type="production.cancelled",
                event_payload={
                    "productionId": production_id,
                    "previousState": current.value,
                    "state": ProductionState.CANCELLED.value,
                    "actor": actor,
                    "worker": "none",
                },
                now=self._clock(),
                already_checked=True,
            )
        return saved

    async def record_error(
        self,
        production_id: str,
        *,
        code: str,
        message: str,
    ) -> None:
        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
            if row is None or ProductionState(row.state) in TERMINAL_STATES:
                return
            row.last_error_code = code
            row.last_error_message = message
            await session.save_production(row, expected_version=row.version)

    async def list_outbox(self, production_id: str) -> list[OutboxRow]:
        async with self._ledger.transaction() as session:
            rows = await session.list_outbox()
        return [row for row in rows if row.aggregate_id == production_id]

    async def _require(self, production_id: str) -> ProductionRow:
        async with self._ledger.transaction() as session:
            row = await session.get_production(production_id)
        if row is None:
            raise _missing(production_id)
        return row

    async def _replay(
        self,
        tenant_id: str,
        request_id: str,
        payload_hash: str,
    ) -> AcceptedProduction:
        async with self._ledger.transaction() as session:
            existing = await session.find_production_by_request(tenant_id, request_id)
        if existing is None:
            raise ComicServiceError(
                "IDEMPOTENCY_CONFLICT",
                "idempotency key is busy",
                retryable=True,
            )
        if existing.request_hash != payload_hash:
            raise ComicServiceError(
                "IDEMPOTENCY_CONFLICT",
                "idempotency key was already used for a different request",
                retryable=False,
            )
        return AcceptedProduction(
            production_id=existing.production_id,
            project_id=existing.project_id,
            state=ProductionState(existing.state),
            version=existing.version,
            replayed=True,
            request_hash=existing.request_hash,
        )


def load_request(row: ProductionRow) -> ProductionRequest:
    return ProductionRequest.model_validate(row.request_json)


async def _insert_acceptance(
    session: LedgerSession,
    *,
    tenant_id: str,
    request: ProductionRequest,
    payload_hash: str,
    project: dict[str, Any],
    content_hash: str,
    production_id: str,
    project_id: str,
    phase: str,
    now: datetime,
) -> None:
    request_json = request.model_dump(mode="json", by_alias=True)
    await session.insert_idempotency(
        IdempotencyRow(
            tenant_id=tenant_id,
            request_id=request.prod_client_request_id,
            payload_hash=payload_hash,
            production_id=production_id,
            created_at=now,
        )
    )
    await session.insert_production(
        ProductionRow(
            production_id=production_id,
            project_id=project_id,
            tenant_id=tenant_id,
            state=ProductionState.CREATED.value,
            phase=phase,
            version=0,
            fixing_count=0,
            cancel_requested_at=None,
            budget_limit_fen=rmb_to_fen(request.budget.project_limit_rmb),
            shot_limit_fen=rmb_to_fen(request.budget.shot_limit_rmb),
            max_paid_calls_per_shot=request.budget.max_paid_calls_per_shot,
            reserved_cost_fen=0,
            actual_cost_fen=0,
            can_produce_playable=False,
            degraded=False,
            last_error_code=None,
            last_error_message=None,
            request_hash=payload_hash,
            request_json=request_json,
            stage_facts={"CREATED": {"accepted": True}},
            created_at=now,
            updated_at=now,
        )
    )
    await session.insert_draft(
        DraftRow(
            project_id=project_id,
            revision=0,
            project_json=project,
            content_hash=content_hash,
            created_at=now,
            updated_at=now,
        )
    )
    await session.insert_draft_revision(
        DraftRevisionRow(
            project_id=project_id,
            revision=0,
            project_json=project,
            content_hash=content_hash,
            command_id=None,
            created_at=now,
        )
    )
    await session.insert_outbox(
        OutboxRow(
            event_id=f"evt:{production_id}:accepted",
            aggregate_id=production_id,
            type="comic.worker",
            payload={
                "worker": "analyze",
                "productionId": production_id,
                "state": ProductionState.CREATED.value,
            },
            available_at=now,
            published_at=None,
            attempt=0,
            lease_owner=None,
            lease_expires_at=None,
            created_at=now,
        )
    )


async def _write_transition(
    session: LedgerSession,
    *,
    row: ProductionRow | None,
    expected_state: ProductionState,
    expected_version: int,
    next_state: ProductionState,
    increment_fixing_count: bool,
    event_type: str,
    event_payload: dict[str, Any],
    now: datetime,
    already_checked: bool = False,
) -> ProductionRow:
    if row is None:
        raise _missing("production")
    if not already_checked and (
        row.state != expected_state.value or row.version != expected_version
    ):
        raise _stale(row.production_id)
    row.state = next_state.value
    if increment_fixing_count:
        row.fixing_count += 1
    saved = await session.save_production(row, expected_version=expected_version)
    if saved is None:
        raise _stale(row.production_id)
    await session.insert_outbox(
        OutboxRow(
            event_id=f"evt:{saved.production_id}:{saved.version}:{uuid4().hex[:8]}",
            aggregate_id=saved.production_id,
            type=event_type,
            payload=event_payload,
            available_at=now,
            published_at=None,
            attempt=0,
            lease_owner=None,
            lease_expires_at=None,
            created_at=now,
        )
    )
    return saved


def _snapshot(row: ProductionRow) -> ProductionSnapshot:
    return ProductionSnapshot(
        production_id=row.production_id,
        state=ProductionState(row.state),
        version=row.version,
        fixing_count=row.fixing_count,
    )


def worker_for_state(state: ProductionState) -> str:
    """Return the queue worker that owns this state. ``none`` is an ack with no worker."""

    return _worker_for(state)


def _worker_for(state: ProductionState) -> str:
    if state in {ProductionState.INGESTING, ProductionState.ANALYZING}:
        return "analyze"
    if state is ProductionState.SYNTHESIZING_VOICE:
        return "voice"
    if state in {ProductionState.PREVIEWING, ProductionState.REVIEWING, ProductionState.FIXING}:
        return "preview"
    if state is ProductionState.PACKAGING:
        return "package"
    if state in {
        ProductionState.PREPARING_ASSETS,
        ProductionState.COMPOSING,
        ProductionState.VALIDATING,
        ProductionState.PLANNING_BATCHES,
        ProductionState.RENDERING_BATCHES,
        ProductionState.DELIVERED,
    }:
        return "render"
    return "none"


def _missing(production_id: str) -> ComicServiceError:
    return ComicServiceError(
        "INVALID_REQUEST",
        "production was not found",
        retryable=False,
        details={"productionId": production_id},
    )


def _stale(production_id: str) -> ComicServiceError:
    return ComicServiceError(
        "JOB_LEASE_CONFLICT",
        "production version or state is stale",
        retryable=True,
        details={"productionId": production_id},
    )
