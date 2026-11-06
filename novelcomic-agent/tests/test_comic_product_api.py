"""Product API: replay, conflict, tenant isolation, and cancellation."""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.tools.production import ProductionTools
from novelcomic_agent.comic.tools.project import ProjectTools
from novelcomic_agent.comic.wiring import build_stage_b
from novelcomic_agent.comic.workflow.cost_budget import CostReservation
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    production_request,
    tenant_from_header,
)

HOSTS = frozenset({"cdn.example", "objects.novelcomic.local"})


async def _tenant(request: Request) -> str:
    return await tenant_from_header(request)


def _app():
    remotion = ScriptedRemotion()
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({}),
        allowed_hosts=HOSTS,
        authenticate=_tenant,
    )
    app = FastAPI()
    app.include_router(runtime.router)
    return app, runtime, remotion


def test_replay_conflict_and_cross_tenant() -> None:
    app, runtime, remotion = _app()
    body = production_request().model_dump(mode="json", by_alias=True)
    with TestClient(app) as client:
        headers = {"x-test-tenant": "tenant-a"}
        first = client.post("/v1/comic-productions", json=body, headers=headers)
        second = client.post("/v1/comic-productions", json=body, headers=headers)
        assert first.status_code == 202
        assert second.status_code == 202
        assert first.json()["productionId"] == second.json()["productionId"]
        assert second.json()["replayed"] is True
        assert remotion.create_calls == 1

        changed = production_request(
            pages=[("https://cdn.example/other.png", 1)]
        ).model_dump(mode="json", by_alias=True)
        conflict = client.post(
            "/v1/comic-productions",
            json=changed,
            headers={"x-test-tenant": "tenant-a"},
        )
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"

        production_id = first.json()["productionId"]
        missing = client.get(
            f"/v1/comic-productions/{production_id}",
            headers={"x-test-tenant": "tenant-b"},
        )
        hidden = client.post(
            f"/v1/comic-productions/{production_id}/cancel",
            headers={"x-test-tenant": "tenant-b"},
        )
        assert missing.status_code == 404
        assert hidden.status_code == 404

    assert runtime.service is not None


@pytest.mark.asyncio
async def test_terminal_cancel_is_rejected_and_blocks_paid_work() -> None:
    app, runtime, _remotion = _app()
    body = production_request(request_id="req-terminal").model_dump(mode="json", by_alias=True)
    with TestClient(app) as client:
        created = client.post(
            "/v1/comic-productions",
            json=body,
            headers={"x-test-tenant": "tenant-a"},
        )
        production_id = created.json()["productionId"]
        await _deliver(runtime.productions, production_id)
        rejected = client.post(
            f"/v1/comic-productions/{production_id}/cancel",
            headers={"x-test-tenant": "tenant-a"},
        )
        assert rejected.status_code == 409
        assert rejected.json()["code"] == "INVALID_STATE_TRANSITION"

        fresh = production_request(request_id="req-cancel").model_dump(mode="json", by_alias=True)
        cancelled = client.post(
            "/v1/comic-productions",
            json=fresh,
            headers={"x-test-tenant": "tenant-a"},
        )
        cancelled_id = cancelled.json()["productionId"]
        stopped = client.post(
            f"/v1/comic-productions/{cancelled_id}/cancel",
            headers={"x-test-tenant": "tenant-a"},
        )
        assert stopped.status_code == 200
        assert stopped.json()["state"] == "CANCELLED"

    with pytest.raises(ComicServiceError) as caught:
        await runtime.service.ensure_paid_work_allowed(cancelled_id)
    assert caught.value.code == "PRODUCTION_CANCELLED"
    reserved = await runtime.costs.reserve_operation(
        CostReservation(
            reservation_id="late-work",
            production_id=cancelled_id,
            worst_case_fen=10,
        ),
        provider="tts",
    )
    assert reserved is False


@pytest.mark.asyncio
async def test_tools_delegate_and_refuse_local_overwrite() -> None:
    _unused, runtime, remotion = _app()
    tools = ProductionTools(runtime.service)
    started = await tools.start("tenant-a", production_request(request_id="tool-1"))
    status = await tools.status("tenant-a", started["productionId"])
    assert status["state"] == "CREATED"
    assert status["costFen"] == 0
    project = ProjectTools(runtime.drafts, remotion)
    draft = await project.read(started["projectId"], 0)
    assert draft["revision"] == 0
    with pytest.raises(ComicServiceError) as caught:
        project.overwrite_draft({"project": {}})
    assert caught.value.code == "INVALID_REQUEST"


async def _deliver(productions, production_id: str) -> None:
    order = [
        ProductionState.CREATED,
        ProductionState.INGESTING,
        ProductionState.ANALYZING,
        ProductionState.SYNTHESIZING_VOICE,
        ProductionState.PREPARING_ASSETS,
        ProductionState.COMPOSING,
        ProductionState.VALIDATING,
        ProductionState.PLANNING_BATCHES,
        ProductionState.RENDERING_BATCHES,
        ProductionState.DELIVERED,
    ]
    for current, nxt in zip(order, order[1:], strict=False):
        row = await productions.get_row(production_id)
        await productions.advance(
            production_id=production_id,
            expected_state=current,
            expected_version=row.version,
            next_state=nxt,
            completion_fact={"ok": True},
            can_produce_playable=True,
        )
