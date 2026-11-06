"""Allowed phase B/E production transitions and their guards."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from ..contracts.errors import ComicServiceError


class ProductionState(StrEnum):
    CREATED = "CREATED"
    INGESTING = "INGESTING"
    ANALYZING = "ANALYZING"
    SYNTHESIZING_VOICE = "SYNTHESIZING_VOICE"
    PREPARING_ASSETS = "PREPARING_ASSETS"
    COMPOSING = "COMPOSING"
    VALIDATING = "VALIDATING"
    PREVIEWING = "PREVIEWING"
    REVIEWING = "REVIEWING"
    FIXING = "FIXING"
    PLANNING_BATCHES = "PLANNING_BATCHES"
    RENDERING_BATCHES = "RENDERING_BATCHES"
    PACKAGING = "PACKAGING"
    DELIVERED = "DELIVERED"
    PERMANENT_FAILED = "PERMANENT_FAILED"
    CANCELLED = "CANCELLED"


ProductionPhase = Literal["B", "E"]
CancellationActor = Literal["user", "admin"]

TERMINAL_STATES = frozenset(
    {
        ProductionState.DELIVERED,
        ProductionState.PERMANENT_FAILED,
        ProductionState.CANCELLED,
    }
)

_SHARED_PREFIX: dict[ProductionState, frozenset[ProductionState]] = {
    ProductionState.CREATED: frozenset({ProductionState.INGESTING}),
    ProductionState.INGESTING: frozenset({ProductionState.ANALYZING}),
    ProductionState.ANALYZING: frozenset({ProductionState.SYNTHESIZING_VOICE}),
    ProductionState.SYNTHESIZING_VOICE: frozenset({ProductionState.PREPARING_ASSETS}),
    ProductionState.PREPARING_ASSETS: frozenset({ProductionState.COMPOSING}),
    ProductionState.COMPOSING: frozenset({ProductionState.VALIDATING}),
}

PHASE_B_TRANSITIONS = {
    **_SHARED_PREFIX,
    ProductionState.VALIDATING: frozenset({ProductionState.PLANNING_BATCHES}),
    ProductionState.PLANNING_BATCHES: frozenset({ProductionState.RENDERING_BATCHES}),
    ProductionState.RENDERING_BATCHES: frozenset({ProductionState.DELIVERED}),
}

PHASE_E_TRANSITIONS = {
    **_SHARED_PREFIX,
    ProductionState.VALIDATING: frozenset({ProductionState.PREVIEWING}),
    ProductionState.PREVIEWING: frozenset({ProductionState.REVIEWING}),
    ProductionState.REVIEWING: frozenset(
        {ProductionState.FIXING, ProductionState.PLANNING_BATCHES}
    ),
    ProductionState.FIXING: frozenset({ProductionState.VALIDATING}),
    ProductionState.PLANNING_BATCHES: frozenset({ProductionState.RENDERING_BATCHES}),
    ProductionState.RENDERING_BATCHES: frozenset({ProductionState.PACKAGING}),
    ProductionState.PACKAGING: frozenset({ProductionState.DELIVERED}),
}


@dataclass(frozen=True, slots=True)
class TransitionGuard:
    phase: ProductionPhase
    fixing_count: int
    can_produce_playable: bool
    completion_facts_satisfied: bool = False
    cancellation_actor: CancellationActor | None = None


def assert_transition_allowed(
    current: ProductionState,
    target: ProductionState,
    guard: TransitionGuard,
) -> None:
    """Reject transitions that violate phase routing or durable-fact guards."""

    if current in TERMINAL_STATES:
        _raise_invalid_transition(current, target)

    if target is ProductionState.CANCELLED:
        if guard.cancellation_actor is None:
            raise ComicServiceError(
                "STAGE_GUARD_REJECTED",
                "only a user or administrator may cancel a production",
                retryable=False,
            )
        return

    if target is ProductionState.PERMANENT_FAILED:
        if guard.can_produce_playable:
            raise ComicServiceError(
                "STAGE_GUARD_REJECTED",
                "playable fallback exists; production must continue with downgrade",
                retryable=False,
            )
        return

    transitions = PHASE_B_TRANSITIONS if guard.phase == "B" else PHASE_E_TRANSITIONS
    if target not in transitions.get(current, frozenset()):
        _raise_invalid_transition(current, target)

    if (
        current is ProductionState.REVIEWING
        and target is ProductionState.FIXING
        and guard.fixing_count >= 1
    ):
        raise ComicServiceError(
            "STAGE_GUARD_REJECTED",
            "phase E permits at most one fixing loop",
            retryable=False,
        )

    if not guard.completion_facts_satisfied:
        raise ComicServiceError(
            "STAGE_GUARD_REJECTED",
            f"completion facts for {current} have not been committed",
            retryable=True,
        )


def _raise_invalid_transition(current: ProductionState, target: ProductionState) -> None:
    raise ComicServiceError(
        "INVALID_STATE_TRANSITION",
        f"transition {current} -> {target} is not allowed",
        retryable=False,
    )
