"""State-machine service with an atomic transition/outbox boundary."""

from dataclasses import dataclass
from typing import Any, Protocol

from ..contracts.ids import ProductionId
from .production_states import (
    ProductionState,
    TransitionGuard,
    assert_transition_allowed,
)


@dataclass(frozen=True, slots=True)
class ProductionSnapshot:
    production_id: ProductionId
    state: ProductionState
    version: int
    fixing_count: int


class StateTransitionRepository(Protocol):
    async def get(self, production_id: ProductionId) -> ProductionSnapshot:
        """Read the durable production state."""

    async def transition_with_outbox(
        self,
        *,
        production_id: ProductionId,
        expected_state: ProductionState,
        expected_version: int,
        next_state: ProductionState,
        increment_fixing_count: bool,
        event_type: str,
        event_payload: dict[str, Any],
    ) -> ProductionSnapshot:
        """Atomically compare-and-set state and append its outbox event."""


class ProductionStateMachine:
    def __init__(self, repository: StateTransitionRepository) -> None:
        self._repository = repository

    async def transition(
        self,
        production_id: ProductionId,
        next_state: ProductionState,
        guard: TransitionGuard,
    ) -> ProductionSnapshot:
        current = await self._repository.get(production_id)
        effective_guard = TransitionGuard(
            phase=guard.phase,
            fixing_count=current.fixing_count,
            can_produce_playable=guard.can_produce_playable,
            completion_facts_satisfied=guard.completion_facts_satisfied,
            cancellation_actor=guard.cancellation_actor,
        )
        assert_transition_allowed(current.state, next_state, effective_guard)
        return await self._repository.transition_with_outbox(
            production_id=production_id,
            expected_state=current.state,
            expected_version=current.version,
            next_state=next_state,
            increment_fixing_count=next_state is ProductionState.FIXING,
            event_type="production.state.changed",
            event_payload={
                "production_id": production_id,
                "previous_state": current.state,
                "state": next_state,
            },
        )
