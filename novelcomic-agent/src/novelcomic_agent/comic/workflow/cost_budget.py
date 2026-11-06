"""Integer-fen budget reservation and settlement boundary."""

from dataclasses import dataclass
from typing import Protocol

from ..contracts.errors import ComicServiceError
from ..contracts.ids import ProductionId, ShotId


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    project_limit_fen: int
    shot_limit_fen: int
    reserved_project_fen: int
    actual_project_fen: int
    reserved_shot_fen: int
    actual_shot_fen: int
    paid_calls_for_shot: int
    max_paid_calls_per_shot: int
    cancel_requested: bool


@dataclass(frozen=True, slots=True)
class CostReservation:
    reservation_id: str
    production_id: ProductionId
    worst_case_fen: int
    shot_id: ShotId | None = None
    provider_request_id: str | None = None


class BudgetRepository(Protocol):
    async def reserve_if_allowed(self, reservation: CostReservation) -> bool:
        """Atomically check cancellation/limits and reserve worst-case cost."""

    async def settle(self, reservation_id: str, actual_fen: int) -> None:
        """Settle actual cost and release the reservation difference."""

    async def release(self, reservation_id: str) -> None:
        """Release a reservation that produced no billable cost."""


def can_reserve(snapshot: BudgetSnapshot, worst_case_fen: int) -> bool:
    """Evaluate project, shot, call-count, and cancellation limits."""

    if not _valid_fen(worst_case_fen) or snapshot.cancel_requested:
        return False
    if snapshot.paid_calls_for_shot >= snapshot.max_paid_calls_per_shot:
        return False
    project_committed = snapshot.reserved_project_fen + snapshot.actual_project_fen
    shot_committed = snapshot.reserved_shot_fen + snapshot.actual_shot_fen
    return (
        project_committed + worst_case_fen <= snapshot.project_limit_fen
        and shot_committed + worst_case_fen <= snapshot.shot_limit_fen
    )


def enhancement_allowed(snapshot: BudgetSnapshot) -> bool:
    """Stop L2/L3 once committed project cost reaches 80 percent."""

    committed = snapshot.reserved_project_fen + snapshot.actual_project_fen
    return committed * 100 < snapshot.project_limit_fen * 80


class CostBudgetService:
    def __init__(self, repository: BudgetRepository) -> None:
        self._repository = repository

    async def reserve(self, reservation: CostReservation) -> None:
        if not _valid_fen(reservation.worst_case_fen):
            raise ValueError("worst_case_fen must be a non-negative integer")
        if not await self._repository.reserve_if_allowed(reservation):
            raise ComicServiceError(
                "BUDGET_EXCEEDED",
                "cost reservation rejected by budget or cancellation guard",
                retryable=False,
            )

    async def settle(self, reservation_id: str, actual_fen: int) -> None:
        if not _valid_fen(actual_fen):
            raise ValueError("actual_fen must be a non-negative integer")
        await self._repository.settle(reservation_id, actual_fen)


def _valid_fen(value: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
