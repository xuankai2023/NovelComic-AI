"""Integer-fen reservations, settlement, refunds, and provider reconciliation."""

from __future__ import annotations

from ..contracts.errors import ComicServiceError
from ..persistence.ledger import Ledger, LedgerSession
from ..persistence.rows import CostRow, ProductionRow, ShotBudgetRow, utcnow
from ..workflow.cost_budget import BudgetSnapshot, CostReservation, can_reserve


class CostRepository:
    """Operation-key ledger. Repeated settle or refund does not move money twice."""

    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def reserve_if_allowed(self, reservation: CostReservation) -> bool:
        return await self.reserve_operation(reservation, provider="unspecified")

    async def reserve_operation(self, reservation: CostReservation, *, provider: str) -> bool:
        if reservation.worst_case_fen < 0:
            raise ValueError("worst_case_fen must be a non-negative integer")
        now = utcnow()
        async with self._ledger.transaction() as session:
            existing = await session.get_cost(reservation.reservation_id)
            if existing is None:
                existing = await session.find_cost_by_operation(
                    reservation.production_id,
                    reservation.reservation_id,
                )
            if existing is not None and existing.status in {
                "reserved",
                "settled",
                "reconciliation_required",
            }:
                return True
            production = await session.get_production(reservation.production_id)
            if production is None or production.cancel_requested_at is not None:
                return False
            shot = None
            if reservation.shot_id is not None:
                shot = await session.get_shot_budget(
                    reservation.production_id,
                    reservation.shot_id,
                )
            if not can_reserve(
                _snapshot(production, shot, reservation.shot_id),
                reservation.worst_case_fen,
            ):
                return False
            if existing is not None and existing.status == "released":
                existing.status = "reserved"
                existing.reservation_fen = reservation.worst_case_fen
                existing.actual_fen = None
                existing.provider = provider
                existing.provider_request_id = reservation.provider_request_id
                existing.shot_id = reservation.shot_id
                await session.save_cost(existing)
            else:
                await session.insert_cost(
                    CostRow(
                        cost_entry_id=reservation.reservation_id,
                        production_id=reservation.production_id,
                        shot_id=reservation.shot_id,
                        provider=provider,
                        provider_request_id=reservation.provider_request_id,
                        operation_key=reservation.reservation_id,
                        reservation_fen=reservation.worst_case_fen,
                        actual_fen=None,
                        refunded_fen=0,
                        status="reserved",
                        created_at=now,
                        updated_at=now,
                    )
                )
            production.reserved_cost_fen += reservation.worst_case_fen
            if reservation.shot_id is not None:
                if shot is None:
                    shot = ShotBudgetRow(
                        production_id=reservation.production_id,
                        shot_id=reservation.shot_id,
                    )
                shot.reserved_fen += reservation.worst_case_fen
                shot.paid_calls += 1
                await session.save_shot_budget(shot)
            saved = await session.save_production(production, expected_version=production.version)
            if saved is None:
                raise ComicServiceError(
                    "JOB_LEASE_CONFLICT",
                    "budget update lost a production version race",
                    retryable=True,
                )
        return True

    async def settle(self, reservation_id: str, actual_fen: int) -> None:
        if actual_fen < 0:
            raise ValueError("actual_fen must be a non-negative integer")
        async with self._ledger.transaction() as session:
            entry = await self._require(session, reservation_id)
            if entry.status == "settled":
                return
            production = await session.get_production(entry.production_id)
            if production is None:
                raise KeyError(entry.production_id)
            shot = None
            if entry.shot_id is not None:
                shot = await session.get_shot_budget(entry.production_id, entry.shot_id)
            if entry.status == "released":
                production.actual_cost_fen += actual_fen
                if shot is not None:
                    shot.actual_fen += actual_fen
            elif entry.status in {"reserved", "reconciliation_required"}:
                if actual_fen > entry.reservation_fen:
                    raise ComicServiceError(
                        "BUDGET_EXCEEDED",
                        "actual cost exceeds the reserved worst case",
                        retryable=False,
                    )
                production.reserved_cost_fen -= entry.reservation_fen
                production.actual_cost_fen += actual_fen
                if shot is not None:
                    shot.reserved_fen -= entry.reservation_fen
                    shot.actual_fen += actual_fen
            else:
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "cost entry cannot be settled from its current status",
                    retryable=False,
                )
            if production.reserved_cost_fen < 0 or production.actual_cost_fen < 0:
                raise ValueError("cost ledger went negative")
            entry.actual_fen = actual_fen
            entry.status = "settled"
            await session.save_cost(entry)
            if shot is not None:
                await session.save_shot_budget(shot)
            await session.save_production(production, expected_version=production.version)

    async def release(self, reservation_id: str) -> None:
        async with self._ledger.transaction() as session:
            entry = await self._require(session, reservation_id)
            if entry.status in {"released", "settled"}:
                return
            production = await session.get_production(entry.production_id)
            if production is None:
                return
            production.reserved_cost_fen -= entry.reservation_fen
            shot = None
            if entry.shot_id is not None:
                shot = await session.get_shot_budget(entry.production_id, entry.shot_id)
                if shot is not None:
                    shot.reserved_fen -= entry.reservation_fen
                    shot.paid_calls = max(0, shot.paid_calls - 1)
                    await session.save_shot_budget(shot)
            entry.status = "released"
            await session.save_cost(entry)
            await session.save_production(production, expected_version=production.version)

    async def refund(self, reservation_id: str, refunded_fen: int) -> None:
        if refunded_fen < 0:
            raise ValueError("refunded_fen must be a non-negative integer")
        async with self._ledger.transaction() as session:
            entry = await self._require(session, reservation_id)
            if entry.status != "settled" or entry.actual_fen is None:
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "only a settled cost can be refunded",
                    retryable=False,
                )
            if refunded_fen < entry.refunded_fen or refunded_fen > entry.actual_fen:
                raise ValueError("refund is outside the settled amount")
            delta = refunded_fen - entry.refunded_fen
            if delta == 0:
                return
            production = await session.get_production(entry.production_id)
            if production is None:
                raise KeyError(entry.production_id)
            production.actual_cost_fen -= delta
            if entry.shot_id is not None:
                shot = await session.get_shot_budget(entry.production_id, entry.shot_id)
                if shot is not None:
                    shot.actual_fen -= delta
                    await session.save_shot_budget(shot)
            entry.refunded_fen = refunded_fen
            await session.save_cost(entry)
            await session.save_production(production, expected_version=production.version)

    async def mark_reconciliation(
        self,
        reservation_id: str,
        provider_request_id: str | None,
    ) -> None:
        async with self._ledger.transaction() as session:
            entry = await self._require(session, reservation_id)
            if entry.status == "settled":
                return
            entry.status = "reconciliation_required"
            if provider_request_id:
                entry.provider_request_id = provider_request_id
            await session.save_cost(entry)

    async def find_by_provider_request(self, provider_request_id: str) -> CostRow | None:
        async with self._ledger.transaction() as session:
            return await session.find_cost_by_provider_request(provider_request_id)

    async def snapshot(
        self,
        production_id: str,
        shot_id: str | None = None,
    ) -> BudgetSnapshot:
        async with self._ledger.transaction() as session:
            production = await session.get_production(production_id)
            if production is None:
                raise KeyError(production_id)
            shot = None
            if shot_id is not None:
                shot = await session.get_shot_budget(production_id, shot_id)
        return _snapshot(production, shot, shot_id)

    async def _require(self, session: LedgerSession, reservation_id: str) -> CostRow:
        entry = await session.get_cost(reservation_id)
        if entry is None:
            raise KeyError(reservation_id)
        return entry


def _snapshot(
    production: ProductionRow,
    shot: ShotBudgetRow | None,
    shot_id: str | None,
) -> BudgetSnapshot:
    if shot_id is None or shot is None:
        reserved_shot = 0
        actual_shot = 0
        paid_calls = 0
        shot_limit = production.budget_limit_fen
    else:
        reserved_shot = shot.reserved_fen
        actual_shot = shot.actual_fen
        paid_calls = shot.paid_calls
        shot_limit = production.shot_limit_fen
    return BudgetSnapshot(
        project_limit_fen=production.budget_limit_fen,
        shot_limit_fen=shot_limit,
        reserved_project_fen=production.reserved_cost_fen,
        actual_project_fen=production.actual_cost_fen,
        reserved_shot_fen=reserved_shot,
        actual_shot_fen=actual_shot,
        paid_calls_for_shot=paid_calls,
        max_paid_calls_per_shot=production.max_paid_calls_per_shot,
        cancel_requested=production.cancel_requested_at is not None,
    )
