"""Consumer half of the AI task contract acceptance chain.

The NovelComic AI vitest starts POST /v1/tasks and sets AI_TASK_BASE_URL.
Without that variable this test is skipped, so the regular consumer suite
does not require the AI process.
"""

from __future__ import annotations

import asyncio
import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from app.config import get_settings
from app.services.invocation import model_invocation_service
from app.services.invocation.model_invocation_planner import ModelInvocationPlan
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.opencreator_ai.schemas import CreateTaskRequest
from app.services.opencreator_ai.task_client import OpenCreatorAITaskClient
from app.services.workflow.flow_node_state_service import FlowNodeStateService

pytestmark = pytest.mark.skipif(
    not os.environ.get("AI_TASK_BASE_URL"),
    reason="AI_TASK_BASE_URL is provided by the AI task contract acceptance test",
)

TRACE_ID = "trace-accept-1"
RUN_ID = "run-accept-1"
NODE_ID = "node-accept-1"
RESULT_ID = "result-accept-1"
FLOW_ID = "flow-accept-1"
FLOW_TASK_ID = "flow-task-accept-1"
PLAN_TOKEN = "plan-accept-1"
CLAIM_TOKEN = "claim-accept-1"
MODEL_ID = "accept-image"
WEBHOOK_URL = "http://127.0.0.1:8001/v1/ai/tasks/callback"


def _write_result(path: str, payload: dict[str, Any]) -> None:
    Path(path).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


class MemoryCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(deepcopy(document))

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return deepcopy(document)
        return None


class MemoryDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, MemoryCollection] = {}

    def __getitem__(self, name: str) -> MemoryCollection:
        if name not in self.collections:
            self.collections[name] = MemoryCollection()
        return self.collections[name]


class RecordingClient(OpenCreatorAITaskClient):
    calls: list[dict[str, Any]] = []

    def _post_json(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        status_code, payload = super()._post_json(body)
        self.calls.append({"status_code": status_code, "body": body, "payload": payload})
        return status_code, payload


def _flow() -> dict[str, Any]:
    return {
        "flow_id": FLOW_ID,
        "flow_run_id": RUN_ID,
        "flow_task_id": FLOW_TASK_ID,
        "locale": "zh",
        "run_id": RUN_ID,
        "trace_id": TRACE_ID,
        "webhook_url": WEBHOOK_URL,
    }


def _node() -> dict[str, Any]:
    return {
        "node_id": NODE_ID,
        "node_type": "imageModel",
        "node_data": {
            "id": NODE_ID,
            "type": "imageModel",
            "data": {"selectedModels": [MODEL_ID]},
        },
    }


def _plan() -> ModelInvocationPlan:
    return ModelInvocationPlan(
        execution_plan_token=PLAN_TOKEN,
        execution_plans=[{"model_id": MODEL_ID, "result_id": RESULT_ID}],
        result_id=RESULT_ID,
    )


@pytest.mark.asyncio
async def test_consumer_links_invocation_to_ai_task(monkeypatch: pytest.MonkeyPatch) -> None:
    RecordingClient.calls = []
    monkeypatch.setattr(model_invocation_service, "OpenCreatorAITaskClient", RecordingClient)

    settings = get_settings()
    settings.oc_api_url = os.environ["AI_TASK_BASE_URL"]
    if not (settings.oc_auth_key or settings.opencreator_ai_auth_key).strip():
        monkeypatch.setattr(settings, "oc_auth_key", "test-auth-key")
    settings.consumer_public_base_url = "http://127.0.0.1:8001"
    settings.ai_submit_timeout_seconds = 5

    database = MemoryDatabase()
    await database[FlowNodeStateService.COLLECTION].insert_one(
        {
            "execution_claim_token": CLAIM_TOKEN,
            "node_id": NODE_ID,
            "run_id": RUN_ID,
            "status": "running",
        }
    )
    plan = _plan()
    await ModelInvocationService.submit_planned_node(
        database,
        flow=_flow(),
        node=_node(),
        plan=plan,
        execution_claim_token=CLAIM_TOKEN,
        inputs={"upstream": {"asset": "selected-image"}},
    )

    assert len(RecordingClient.calls) == 1
    created = RecordingClient.calls[0]
    body = created["body"]
    assert created["status_code"] == 202
    assert body["model_id"] == MODEL_ID
    assert body["trace_id"] == TRACE_ID
    assert body["idempotency_key"] == RESULT_ID
    assert body["locale"] == "zh"
    assert body["webhook_url"] == WEBHOOK_URL
    assert set(body["options"]) == {"execution_plans", "inputs", "node"}
    assert body["options"]["inputs"] == {"upstream": {"asset": "selected-image"}}
    assert body["options"]["execution_plans"] == [{"model_id": MODEL_ID, "result_id": RESULT_ID}]
    assert body["client_context"]["flow_id"] == FLOW_ID
    assert body["client_context"]["flow_run_id"] == RUN_ID
    assert body["client_context"]["flow_task_id"] == FLOW_TASK_ID
    assert body["client_context"]["node_id"] == NODE_ID
    assert body["client_context"]["node_type"] == "imageModel"
    assert body["client_context"]["result_id"] == RESULT_ID
    assert body["client_context"]["run_id"] == RUN_ID
    assert body["client_context"]["execution_plan_token"] == PLAN_TOKEN
    assert created["payload"]["status"] == "queued"
    assert created["payload"]["ai_task_id"]

    replay_client = RecordingClient(
        base_url=settings.oc_api_url,
        timeout_seconds=settings.ai_submit_timeout_seconds,
    )
    replayed = await replay_client.create_task(CreateTaskRequest.model_validate(body))
    replay_call = RecordingClient.calls[1]
    assert replay_call["status_code"] == 200
    assert replayed.ai_task_id == created["payload"]["ai_task_id"]
    assert replayed.status == "existing"
    assert replayed.existing is True

    invocations = database[ModelInvocationService.COLLECTION].docs
    assert len(invocations) == 1
    invocation = await database[ModelInvocationService.COLLECTION].find_one({"trace_id": TRACE_ID})
    assert invocation is not None
    assert invocation["ai_task_id"] == created["payload"]["ai_task_id"]
    assert invocation["idempotency_key"] == RESULT_ID
    assert invocation["run_id"] == RUN_ID
    assert invocation["node_id"] == NODE_ID
    assert invocation["client_context"] == body["client_context"]
    assert invocation["provider_gateway_status"] == "queued"
    assert invocation["status"] == "queued"

    node = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": RUN_ID, "node_id": NODE_ID}
    )
    assert node is not None
    assert node["status"] == "running"

    result_path = os.environ.get("AI_TASK_CHAIN_RESULT")
    if result_path:
        payload = {
            "create": {
                "http_status": created["status_code"],
                "ai_task_id": created["payload"]["ai_task_id"],
                "task_status": created["payload"]["status"],
                "request_body": body,
            },
            "replay": {
                "http_status": replay_call["status_code"],
                "ai_task_id": replayed.ai_task_id,
                "task_status": replayed.status,
                "existing": replayed.existing,
            },
            "invocation": {
                "ai_task_id": invocation["ai_task_id"],
                "trace_id": invocation["trace_id"],
                "idempotency_key": invocation["idempotency_key"],
                "client_context": invocation["client_context"],
                "run_id": invocation["run_id"],
                "node_id": invocation["node_id"],
                "flow_run_id": invocation["flow_run_id"],
                "flow_task_id": invocation["flow_task_id"],
                "result_id": invocation["result_id"],
                "provider_gateway_status": invocation["provider_gateway_status"],
                "status": invocation["status"],
            },
            "invocation_count": len(invocations),
            "node_status": node["status"],
        }
        await asyncio.to_thread(_write_result, result_path, payload)
