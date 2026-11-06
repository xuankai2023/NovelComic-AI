from dataclasses import replace

from novelcomic_agent.comic.workflow.cost_budget import (
    BudgetSnapshot,
    can_reserve,
    enhancement_allowed,
)


def budget() -> BudgetSnapshot:
    return BudgetSnapshot(
        project_limit_fen=10_000,
        shot_limit_fen=2_000,
        reserved_project_fen=1_000,
        actual_project_fen=2_000,
        reserved_shot_fen=200,
        actual_shot_fen=300,
        paid_calls_for_shot=1,
        max_paid_calls_per_shot=3,
        cancel_requested=False,
    )


def test_reservation_obeys_project_shot_call_and_cancel_limits() -> None:
    snapshot = budget()

    assert can_reserve(snapshot, 1_500)
    assert not can_reserve(snapshot, 1_501)
    assert not can_reserve(replace(snapshot, paid_calls_for_shot=3), 1)
    assert not can_reserve(replace(snapshot, cancel_requested=True), 1)


def test_enhancement_stops_at_eighty_percent_committed_cost() -> None:
    snapshot = budget()

    assert enhancement_allowed(snapshot)
    assert not enhancement_allowed(
        replace(snapshot, reserved_project_fen=6_000, actual_project_fen=2_000)
    )
