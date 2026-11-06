"""Acceptance races, stale workers, cancellation, and tenant isolation."""

from __future__ import annotations

import asyncio

import pytest

from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.repositories.production_repository import (
    ProductionNotFoundError,
    ProductionRepository,
)
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import empty_project, production_request


async def _accept(repo: ProductionRepository, production_id: str, project_id: str, request_id: str):
    project = empty_project()
    return await repo.accept(
        tenant_id="tenant-a",
        request=production_request(request_id=request_id),
        project=project,
        content_hash=project_content_hash(project),
        production_id=production_id,
        project_id=project_id,
    )


async def test_concurrent_accept_commits_one_production() -> None:
    repo = ProductionRepository(MemoryLedger())
    request = production_request(request_id="same")
    project = empty_project()
    content_hash = project_content_hash(project)

    async def accept(production_id: str, project_id: str):
        return await repo.accept(
            tenant_id="tenant-a",
            request=request,
            project=project,
            content_hash=content_hash,
            production_id=production_id,
            project_id=project_id,
        )

    first, second = await asyncio.gather(accept("prod_a", "prj_a"), accept("prod_b", "prj_b"))
    assert first.production_id == second.production_id
    assert {first.replayed, second.replayed} == {False, True}
    events = await repo.list_outbox(first.production_id)
    assert len(events) == 1


async def test_stale_advance_does_not_move_state_backward() -> None:
    repo = ProductionRepository(MemoryLedger())
    accepted = await _accept(repo, "prod_stale", "prj_stale", "req-stale")
    await repo.advance(
        production_id=accepted.production_id,
        expected_state=ProductionState.CREATED,
        expected_version=0,
        next_state=ProductionState.INGESTING,
        completion_fact={"pages": []},
        can_produce_playable=False,
    )
    await repo.record_error(accepted.production_id, code="COMPOSE_FAILED", message="bump")
    with pytest.raises(ComicServiceError) as caught:
        await repo.advance(
            production_id=accepted.production_id,
            expected_state=ProductionState.INGESTING,
            expected_version=1,
            next_state=ProductionState.ANALYZING,
            completion_fact={"panels": []},
            can_produce_playable=True,
        )
    assert caught.value.code == "JOB_LEASE_CONFLICT"
    row = await repo.get_row(accepted.production_id)
    assert row.state == ProductionState.INGESTING.value
    assert row.version == 2

    await repo.advance(
        production_id=accepted.production_id,
        expected_state=ProductionState.INGESTING,
        expected_version=row.version,
        next_state=ProductionState.ANALYZING,
        completion_fact={"panels": []},
        can_produce_playable=True,
    )
    with pytest.raises(ComicServiceError):
        await repo.advance(
            production_id=accepted.production_id,
            expected_state=ProductionState.CREATED,
            expected_version=0,
            next_state=ProductionState.INGESTING,
            completion_fact={"pages": []},
            can_produce_playable=False,
        )
    current = await repo.get_row(accepted.production_id)
    assert current.state == ProductionState.ANALYZING.value


async def test_two_cancels_and_tenant_isolation() -> None:
    repo = ProductionRepository(MemoryLedger())
    accepted = await _accept(repo, "prod_cancel", "prj_cancel", "req-cancel")

    async def cancel():
        return await repo.cancel(
            tenant_id="tenant-a",
            production_id=accepted.production_id,
            actor="user",
        )

    results = await asyncio.gather(cancel(), cancel(), return_exceptions=True)
    successes = [item for item in results if not isinstance(item, Exception)]
    failures = [item for item in results if isinstance(item, ComicServiceError)]
    assert len(successes) == 1
    assert successes[0].state == ProductionState.CANCELLED.value
    assert len(failures) == 1
    assert failures[0].code == "INVALID_STATE_TRANSITION"
    hidden = await repo.get_for_tenant("tenant-b", accepted.production_id)
    assert hidden is None
    with pytest.raises(ProductionNotFoundError):
        await repo.cancel(
            tenant_id="tenant-b",
            production_id=accepted.production_id,
            actor="user",
        )
