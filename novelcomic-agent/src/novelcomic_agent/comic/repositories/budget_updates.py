"""Shared reservation mutations used by budget settlement and cancellation."""

from __future__ import annotations

from ..persistence.ledger import LedgerSession
from ..persistence.rows import CostRow, ProductionRow


async def release_open_reservations(session: LedgerSession, production: ProductionRow) -> None:
    """Return unused reservations when a production is cancelled."""

    for cost in await session.list_costs(production.production_id):
        if cost.status not in {"reserved", "reconciliation_required"}:
            continue
        _release_cost(production, cost)
        shot = None
        if cost.shot_id:
            shot = await session.get_shot_budget(production.production_id, cost.shot_id)
        if shot is not None:
            shot.reserved_fen -= cost.reservation_fen
            shot.paid_calls = max(0, shot.paid_calls - 1)
            _non_negative(shot.reserved_fen, "shot reserved fen")
            await session.save_shot_budget(shot)
        cost.status = "released"
        await session.save_cost(cost)


def _release_cost(production: ProductionRow, cost: CostRow) -> None:
    production.reserved_cost_fen -= cost.reservation_fen
    _non_negative(production.reserved_cost_fen, "reserved fen")


def _non_negative(value: int, label: str) -> None:
    if value < 0:
        raise ValueError(f"{label} cannot be negative")
