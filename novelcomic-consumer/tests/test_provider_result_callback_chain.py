"""Consume the raw AI callback body and match it back onto a workflow node."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import get_settings
from app.main import create_app
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService


def _load_fakes() -> Any:
    path = Path(__file__).with_name("test_workflow_dag_execution.py")
    spec = importlib.util.spec_from_file_location("workflow_dag_execution_fakes", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load workflow test fakes")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_FAKES = _load_fakes()
FakeDatabase = _FAKES.FakeDatabase
FakePublisher = _FAKES.FakePublisher
FakeConnections = _FAKES.FakeConnections

pytestmark = pytest.mark.skipif(
    not os.environ.get("PROVIDER_CHAIN_CALLBACKS"),
    reason="full callback chain is launched by the AI acceptance test",
)


def _verify(secret: str, headers: dict[str, str], raw_body: bytes) -> bool:
    timestamp = headers["x-oc-timestamp"]
    signature = headers["x-oc-signature"]
    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def node(node_id: str, node_type: str) -> dict[str, Any]:
    return {"id": node_id, "type": node_type, "data": {}}


async def _prepare_run(
    database: Any,
    *,
    run_id: str,
    flow_task_id: str,
    command_id: str,
    result_id: str,
    ai_task_id: str | None,
) -> None:
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id=run_id,
        flow_task_id=flow_task_id,
        user_id="user-chain",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id=command_id,
    )
    await FlowNodeStateService.init_nodes(database, run_id=run_id, dag=dag)
    await FlowNodeStateService.set_expected_result(
        database,
        run_id=run_id,
        node_id="model",
        result_id=result_id,
        execution_plan_token=f"plan-{run_id}",
    )
    await FlowNodeStateService.set_status(
        database,
        run_id=run_id,
        node_id="model",
        status="running",
    )
    invocation: dict[str, Any] = {
        "_id": f"inv-{run_id}",
        "client_context": {
            "node_id": "model",
            "result_id": result_id,
            "run_id": run_id,
        },
        "node_id": "model",
        "result_id": result_id,
        "run_id": run_id,
        "status": "queued",
    }
    if ai_task_id:
        invocation["ai_task_id"] = ai_task_id
    await database[ModelInvocationService.COLLECTION].insert_one(invocation)


def _node_status_events(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        message["payload"]
        for message in messages
        if message["payload"].get("event_type") == "node_status"
    ]


@pytest.mark.asyncio
async def test_provider_result_callback_matches_invocation_and_publishes_workflow_event() -> None:
    callback_path = Path(os.environ["PROVIDER_CHAIN_CALLBACKS"])
    frontend_path = Path(os.environ["PROVIDER_CHAIN_FRONTEND"])
    result_path = Path(os.environ["PROVIDER_CHAIN_RESULT"])
    chain = json.loads(callback_path.read_text())
    secret = str(chain["secret"])
    settings = get_settings()
    original_secret = settings.consumer_webhook_secret
    settings.consumer_webhook_secret = secret

    database = FakeDatabase()
    publisher = FakePublisher()
    success_payload = json.loads(chain["success"]["rawBody"])
    context_payload = json.loads(chain["context"]["rawBody"])
    await _prepare_run(
        database,
        run_id="run-chain",
        flow_task_id="flow-task-chain",
        command_id="cmd-chain",
        result_id="result-chain",
        ai_task_id=str(success_payload["ai_task_id"]),
    )
    await _prepare_run(
        database,
        run_id="run-context",
        flow_task_id="flow-task-context",
        command_id="cmd-context",
        result_id="result-context",
        ai_task_id=None,
    )
    context_before = await database[ModelInvocationService.COLLECTION].find_one(
        {"run_id": "run-context", "node_id": "model", "result_id": "result-context"}
    )
    assert context_before is not None
    assert "ai_task_id" not in context_before
    assert await database[ModelInvocationService.COLLECTION].find_one(
        {"ai_task_id": context_payload["ai_task_id"]}
    ) is None

    app = create_app()
    app.state.connections = FakeConnections(database)
    app.state.callback_publisher = publisher
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            success_body = chain["success"]["rawBody"].encode("utf-8")
            success_headers = dict(chain["success"]["headers"])
            assert _verify(secret, success_headers, success_body)
            tampered = dict(success_headers)
            tampered["x-oc-signature"] = "0" * 64
            rejected = await client.post(
                "/callbacks/models/opencreator_ai",
                content=success_body,
                headers=tampered,
            )
            assert rejected.status_code == 401
            assert rejected.json()["status"] == "invalid_signature"

            accepted = await client.post(
                "/callbacks/models/opencreator_ai",
                content=success_body,
                headers=success_headers,
            )
            published_once = len(publisher.messages)
            replay = await client.post(
                "/callbacks/models/opencreator_ai",
                content=success_body,
                headers=success_headers,
            )
            assert replay.status_code == 200
            assert len(publisher.messages) == published_once

            context_body = chain["context"]["rawBody"].encode("utf-8")
            context_headers = dict(chain["context"]["headers"])
            assert _verify(secret, context_headers, context_body)
            context_response = await client.post(
                "/callbacks/models/opencreator_ai",
                content=context_body,
                headers=context_headers,
            )
    finally:
        settings.consumer_webhook_secret = original_secret

    assert accepted.status_code == 200
    assert accepted.json()["matched"] is True
    assert accepted.json()["ai_task_id"] == success_payload["ai_task_id"]

    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"ai_task_id": success_payload["ai_task_id"]}
    )
    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-chain", "node_id": "model"}
    )
    assert invocation is not None
    assert invocation["status"] == "success"
    assert invocation["client_context"]["run_id"] == "run-chain"
    assert invocation["result"]["output"] == "chain output"
    assert model_doc["status"] == "success"

    assert context_response.status_code == 200
    assert context_response.json()["matched"] is True
    context_invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"run_id": "run-context", "node_id": "model", "result_id": "result-context"}
    )
    assert context_invocation is not None
    assert context_invocation["ai_task_id"] == context_payload["ai_task_id"]
    assert context_invocation["status"] == "success"

    workflow_events = _node_status_events(publisher.messages)
    assert workflow_events
    for event in workflow_events:
        assert event["event_type"] == "node_status"
        assert "ai_task_id" not in event
        assert "ai_task_id" not in event.get("payload", {})
        assert event.get("payload", {}).get("status") != "succeeded"
        assert "waiting_provider" not in json.dumps(event)
        assert "callback_pending" not in json.dumps(event)
    model_event = next(
        event
        for event in workflow_events
        if event.get("payload", {}).get("node_id") == "model"
        and event.get("payload", {}).get("run_id") == "run-chain"
        and event.get("payload", {}).get("status") == "success"
    )
    frontend_path.write_text(json.dumps({"event": model_event}, ensure_ascii=False))
    result_path.write_text(
        json.dumps(
            {
                "success_matched": True,
                "context_matched": True,
                "node_status": model_doc["status"],
                "workflow_event_type": model_event["event_type"],
            }
        )
    )
