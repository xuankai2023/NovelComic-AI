import pytest

from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.workflow.production_states import (
    ProductionPhase,
    ProductionState,
    TransitionGuard,
    assert_transition_allowed,
)


def guard(phase: ProductionPhase, *, fixing_count: int = 0) -> TransitionGuard:
    return TransitionGuard(
        phase=phase,
        fixing_count=fixing_count,
        can_produce_playable=True,
        completion_facts_satisfied=True,
    )


def test_phase_b_skips_review_and_packaging() -> None:
    assert_transition_allowed(
        ProductionState.VALIDATING,
        ProductionState.PLANNING_BATCHES,
        guard("B"),
    )
    assert_transition_allowed(
        ProductionState.RENDERING_BATCHES,
        ProductionState.DELIVERED,
        guard("B"),
    )


def test_phase_e_requires_review_and_packaging() -> None:
    assert_transition_allowed(
        ProductionState.VALIDATING,
        ProductionState.PREVIEWING,
        guard("E"),
    )
    with pytest.raises(ComicServiceError, match="not allowed"):
        assert_transition_allowed(
            ProductionState.RENDERING_BATCHES,
            ProductionState.DELIVERED,
            guard("E"),
        )


def test_phase_e_allows_only_one_fixing_loop() -> None:
    with pytest.raises(ComicServiceError, match="at most one fixing loop"):
        assert_transition_allowed(
            ProductionState.REVIEWING,
            ProductionState.FIXING,
            guard("E", fixing_count=1),
        )


def test_playable_fallback_prevents_permanent_failure() -> None:
    with pytest.raises(ComicServiceError, match="playable fallback exists"):
        assert_transition_allowed(
            ProductionState.ANALYZING,
            ProductionState.PERMANENT_FAILED,
            guard("B"),
        )
