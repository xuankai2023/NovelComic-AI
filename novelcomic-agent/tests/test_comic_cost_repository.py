"""Budget reservation, settlement, refund, cancellation, and the 80 percent brake."""

from __future__ import annotations

import asyncio

from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.repositories.cost_repository import CostRepository
from novelcomic_agent.comic.repositories.production_repository import ProductionRepository
from novelcomic_agent.comic.workflow.cost_budget import CostReservation, enhancement_allowed
from tests.comic_support import empty_project, production_request


async def _open(limit: str = "1.00") -> tuple[CostRepository, ProductionRepository, str]:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    project = empty_project()
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(
            project_limit=limit,
            shot_limit=limit,
            max_calls=5,
            request_id=f"budget-{limit}",
        ),
        project=project,
        content_hash=project_content_hash(project),
        production_id=f"prod_{limit.replace('.', '_')}",
        project_id=f"prj_{limit.replace('.', '_')}",
    )
    return CostRepository(ledger), productions, accepted.production_id


def _reserve(production_id: str, reservation_id: str, fen: int) -> CostReservation:
    return CostReservation(
        reservation_id=reservation_id,
        production_id=production_id,
        worst_case_fen=fen,
    )


async def test_concurrent_reserves_cannot_oversell() -> None:
    costs, productions, production_id = await _open("1.00")
    results = await asyncio.gather(
        costs.reserve_operation(_reserve(production_id, "left", 60), provider="tts"),
        costs.reserve_operation(_reserve(production_id, "right", 60), provider="tts"),
    )
    assert sorted(results) == [False, True]
    row = await productions.get_row(production_id)
    assert row.reserved_cost_fen == 60

    again = await asyncio.gather(
        costs.reserve_operation(_reserve(production_id, "left", 60), provider="tts"),
        costs.reserve_operation(_reserve(production_id, "left", 60), provider="tts"),
    )
    assert again == [True, True]
    assert (await productions.get_row(production_id)).reserved_cost_fen == 60


async def test_settle_refund_cancel_and_enhancement_brake() -> None:
    costs, productions, production_id = await _open("100.00")
    assert await costs.reserve_operation(_reserve(production_id, "voice", 500), provider="tts")
    await costs.settle("voice", 200)
    await costs.settle("voice", 999)
    row = await productions.get_row(production_id)
    assert row.actual_cost_fen == 200
    assert row.reserved_cost_fen == 0

    await costs.refund("voice", 50)
    await costs.refund("voice", 50)
    await costs.refund("voice", 80)
    assert (await productions.get_row(production_id)).actual_cost_fen == 120

    reserved = await costs.reserve_operation(
        _reserve(production_id, "render", 100),
        provider="remotion",
    )
    assert reserved
    await productions.cancel(tenant_id="tenant-a", production_id=production_id, actor="user")
    released = await productions.get_row(production_id)
    assert released.reserved_cost_fen == 0
    assert released.actual_cost_fen == 120
    late = await costs.reserve_operation(_reserve(production_id, "late", 10), provider="tts")
    assert late is False


async def test_enhancement_stops_at_eighty_percent() -> None:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    project = empty_project()
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(project_limit="100.00", shot_limit="100.00", max_calls=5),
        project=project,
        content_hash=project_content_hash(project),
        production_id="prod_brake",
        project_id="prj_brake",
    )
    costs = CostRepository(ledger)
    reserved = await costs.reserve_operation(
        _reserve(accepted.production_id, "enhance", 8000),
        provider="l2",
    )
    assert reserved
    snapshot = await costs.snapshot(accepted.production_id)
    assert enhancement_allowed(snapshot) is False
