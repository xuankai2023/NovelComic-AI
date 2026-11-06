"""Re-read the production version immediately before a stage CAS."""

from __future__ import annotations

from typing import Any

from ..contracts.errors import ComicServiceError
from ..repositories.production_repository import ProductionRepository
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import ProductionState


async def commit_stage(
    productions: ProductionRepository,
    production_id: str,
    expected_state: ProductionState,
    fact: dict[str, Any],
    *,
    can_produce_playable: bool,
    degraded: bool = False,
) -> ProductionSnapshot:
    row = await productions.get_row(production_id)
    if ProductionState(row.state) is not expected_state:
        return await productions.get(production_id)
    return await productions.advance(
        production_id=production_id,
        expected_state=expected_state,
        expected_version=row.version,
        next_state=next_production_state(row.phase, expected_state),
        completion_fact=fact,
        can_produce_playable=can_produce_playable,
        degraded=degraded,
    )


def next_production_state(phase: str, current: ProductionState) -> ProductionState:
    table = _NEXT_E if phase == "E" else _NEXT_B
    try:
        return table[current]
    except KeyError as exc:
        raise ComicServiceError(
            "INVALID_STATE_TRANSITION",
            f"phase {phase} has no linear successor for {current.value}",
            retryable=False,
        ) from exc


_NEXT_B = {
    ProductionState.CREATED: ProductionState.INGESTING,
    ProductionState.INGESTING: ProductionState.ANALYZING,
    ProductionState.ANALYZING: ProductionState.SYNTHESIZING_VOICE,
    ProductionState.SYNTHESIZING_VOICE: ProductionState.PREPARING_ASSETS,
    ProductionState.PREPARING_ASSETS: ProductionState.COMPOSING,
    ProductionState.COMPOSING: ProductionState.VALIDATING,
    ProductionState.VALIDATING: ProductionState.PLANNING_BATCHES,
    ProductionState.PLANNING_BATCHES: ProductionState.RENDERING_BATCHES,
    ProductionState.RENDERING_BATCHES: ProductionState.DELIVERED,
}

_NEXT_E = {
    ProductionState.CREATED: ProductionState.INGESTING,
    ProductionState.INGESTING: ProductionState.ANALYZING,
    ProductionState.ANALYZING: ProductionState.SYNTHESIZING_VOICE,
    ProductionState.SYNTHESIZING_VOICE: ProductionState.PREPARING_ASSETS,
    ProductionState.PREPARING_ASSETS: ProductionState.COMPOSING,
    ProductionState.COMPOSING: ProductionState.VALIDATING,
    ProductionState.VALIDATING: ProductionState.PREVIEWING,
    ProductionState.PREVIEWING: ProductionState.REVIEWING,
    ProductionState.FIXING: ProductionState.VALIDATING,
    ProductionState.PLANNING_BATCHES: ProductionState.RENDERING_BATCHES,
    ProductionState.RENDERING_BATCHES: ProductionState.PACKAGING,
}
