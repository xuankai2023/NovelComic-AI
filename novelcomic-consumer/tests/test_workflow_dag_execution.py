from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.main import create_app
from app.model_gateway.providers.opencreator_ai import OpenCreatorAIProvider
from app.services.invocation.invocation_finalizer import InvocationFinalizer
from app.services.invocation.model_invocation_planner import (
    ModelInvocationPlan,
    ModelInvocationPlanner,
)
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.opencreator_ai.task_client import (
    OpenCreatorAISubmitError,
    OpenCreatorAITaskData,
)
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.services.workflow.node_aggregation_service import NodeAggregationService
from app.tasks.flow import FLOW_START_LOCK_PREFIX, FlowTask, decode_stream_payload
from app.tasks.flow_resume import FLOW_RESUME_LOCK_PREFIX, FlowResumeTask


class UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int = 1) -> FakeCursor:
        self.docs.sort(
            key=lambda document: (document.get(key) is None, document.get(key)),
            reverse=int(direction) < 0,
        )
        return self

    def limit(self, count: int) -> FakeCursor:
        self.docs = self.docs[:count]
        return self

    def __aiter__(self) -> FakeCursor:
        self._index = 0
        return self

    async def __anext__(self) -> dict[str, Any]:
        if self._index >= len(self.docs):
            raise StopAsyncIteration
        doc = self.docs[self._index]
        self._index += 1
        return deepcopy(doc)


class FakeCollection:
    def __init__(self) -> None:
        self.docs: dict[Any, dict[str, Any]] = {}

    @staticmethod
    def _identity(document: dict[str, Any]) -> Any:
        return (
            document.get("_id")
            or (
                document.get("run_id"),
                document.get("node_id"),
            )
            or id(document)
        )

    @staticmethod
    def _get(document: dict[str, Any], key: str) -> Any:
        if key in document or "." not in key:
            return document.get(key)
        current: Any = document
        for part in key.split("."):
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        return current

    def _matches(self, document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            if key == "$or":
                if not any(self._matches(document, branch) for branch in expected):
                    return False
                continue
            if key == "$and":
                if not all(self._matches(document, branch) for branch in expected):
                    return False
                continue
            actual = self._get(document, key)
            if isinstance(expected, dict) and any(str(op).startswith("$") for op in expected):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                if "$lt" in expected and (actual is None or actual >= expected["$lt"]):
                    return False
                if "$lte" in expected and (actual is None or actual > expected["$lte"]):
                    return False
                if "$gt" in expected and (actual is None or actual <= expected["$gt"]):
                    return False
                if "$gte" in expected and (actual is None or actual < expected["$gte"]):
                    return False
                if "$exists" in expected and (key in document) is not bool(expected["$exists"]):
                    return False
                if expected.get("$type") == "object" and not isinstance(actual, dict):
                    return False
                continue
            if actual != expected:
                return False
        return True

    @staticmethod
    def _apply(document: dict[str, Any], update: dict[str, Any], *, inserted: bool) -> None:
        if inserted:
            document.update(deepcopy(update.get("$setOnInsert", {})))
        document.update(deepcopy(update.get("$set", {})))
        for key, value in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + value
        for key in update.get("$unset", {}):
            document.pop(key, None)

    async def insert_one(self, document: dict[str, Any]) -> None:
        identity = self._identity(document)
        if identity in self.docs:
            raise DuplicateKeyError("duplicate")
        self.docs[identity] = deepcopy(document)

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs.values():
            if self._matches(document, query):
                return deepcopy(document)
        return None

    def find(self, query: dict[str, Any]) -> FakeCursor:
        return FakeCursor([doc for doc in self.docs.values() if self._matches(doc, query)])

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
        sort: Any = None,
        return_document: Any | None = None,
    ) -> dict[str, Any] | None:
        del return_document
        matches = [
            (identity, document)
            for identity, document in self.docs.items()
            if self._matches(document, query)
        ]
        if sort:
            for key, direction in reversed(list(sort)):
                matches.sort(
                    key=lambda item, field=key: (
                        item[1].get(field) is None,
                        item[1].get(field),
                    ),
                    reverse=int(direction) < 0,
                )
        for identity, document in matches:
            next_doc = deepcopy(document)
            self._apply(next_doc, update, inserted=False)
            self.docs[identity] = next_doc
            return deepcopy(next_doc)
        if not upsert:
            return None
        document = {
            key: value
            for key, value in query.items()
            if not str(key).startswith("$") and not isinstance(value, dict)
        }
        self._apply(document, update, inserted=True)
        identity = self._identity(document)
        if identity in self.docs:
            raise DuplicateKeyError("duplicate")
        self.docs[identity] = document
        return deepcopy(document)

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
    ) -> UpdateResult:
        for identity, document in self.docs.items():
            if self._matches(document, query):
                next_doc = deepcopy(document)
                self._apply(next_doc, update, inserted=False)
                self.docs[identity] = next_doc
                return UpdateResult(1)
        if not upsert:
            return UpdateResult(0)

        document = {key: value for key, value in query.items() if not key.startswith("$")}
        self._apply(document, update, inserted=True)
        self.docs[self._identity(document)] = document
        return UpdateResult(1)

    async def update_many(self, query: dict[str, Any], update: dict[str, Any]) -> UpdateResult:
        matched = 0
        for identity, document in list(self.docs.items()):
            if not self._matches(document, query):
                continue
            next_doc = deepcopy(document)
            self._apply(next_doc, update, inserted=False)
            self.docs[identity] = next_doc
            matched += 1
        return UpdateResult(matched)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakePublisher:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
        self.messages.append({"queue_name": queue_name, "payload": deepcopy(payload)})


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: list[dict[str, Any]] = []

    async def set(
        self,
        key: str,
        value: Any,
        *,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        self.sets.append({"ex": ex, "key": key, "nx": nx, "value": value})
        if nx and key in self.values:
            return None
        self.values[key] = value.decode() if isinstance(value, bytes) else str(value)
        return True

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def delete(self, key: str) -> int:
        if key not in self.values:
            return 0
        del self.values[key]
        return 1

    async def xadd(self, queue_name: str, message: dict[str, Any]) -> str:
        self.messages = getattr(self, "messages", [])
        self.messages.append((queue_name, deepcopy(message)))
        return f"{len(self.messages)}-0"


class ObservingPublisher(FakePublisher):
    def __init__(self, database: FakeDatabase) -> None:
        super().__init__()
        self.database = database

    async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
        outbox = await self.database[FlowEventPublishService.COLLECTION].find_one(
            {"_id": payload["event_id"]}
        )
        assert outbox is not None
        assert outbox["status"] == "publishing"
        await super().publish(queue_name=queue_name, payload=payload)


class FakeAITaskClient:
    requests: list[dict[str, Any]] = []

    def __init__(self, *, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url
        self.timeout_seconds = timeout_seconds

    async def create_task(self, request: Any) -> OpenCreatorAITaskData:
        body = request.model_dump(exclude_none=True) if hasattr(request, "model_dump") else request
        self.requests.append(deepcopy(body))
        return OpenCreatorAITaskData(ai_task_id="ai-task-1", status="queued")

    async def submit(self, request: Any) -> OpenCreatorAITaskData:
        return await self.create_task(request)


def node(node_id: str, node_type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": node_id, "type": node_type, "data": data or {}}


@pytest.mark.asyncio
async def test_start_command_initializes_durable_run_nodes_and_ignores_redelivery() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("input", "textInput", {"text": "hello"}), node("next", "textInput")],
        "edges": [{"source": "input", "target": "next"}],
    }
    payload = {
        "command_id": "cmd-start",
        "dag": dag,
        "flow_id": "flow-1",
        "flow_run_id": "run-1",
        "flow_task_id": "task-1",
        "protocol_version": 2,
        "reply_queue": "reply",
        "start_ids": ["input"],
        "trace_id": "trace-1",
        "user_id": "user-1",
        "user_selection": {"external": {"asset": "chosen"}},
    }

    redis = FakeRedis()
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)

    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-1"})
    assert run is not None
    assert run["selected_outputs"] == {"external": {"asset": "chosen"}}
    assert run["start_initialized"] is True

    nodes = await FlowNodeStateService.list_nodes(database, "run-1")
    by_id = {item["node_id"]: item for item in nodes}
    assert by_id["next"]["predecessors"] == ["input"]
    assert by_id["input"]["successors"] == ["next"]
    assert len(database["flow_command_inbox"].docs) == 1
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert event_types.count("start_flow") == 1


@pytest.mark.asyncio
async def test_resume_uses_selected_outputs_for_non_active_predecessors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.invocation import model_invocation_service

    FakeAITaskClient.requests = []
    monkeypatch.setattr(model_invocation_service, "OpenCreatorAITaskClient", FakeAITaskClient)
    settings = get_settings()
    if not (settings.oc_auth_key or settings.opencreator_ai_auth_key).strip():
        monkeypatch.setattr(settings, "oc_auth_key", "test-auth-key")

    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [
            node("upstream", "imageInput"),
            node("model", "imageModel", {"selectedModels": ["default"]}),
        ],
        "edges": [{"source": "upstream", "target": "model"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-2",
        flow_task_id="task-2",
        user_id="user-1",
        ws_id="",
        dag=dag,
        start_ids=["model"],
        reply_queue="reply",
        command_id="cmd-2",
        user_selection={"upstream": {"asset": "selected-image"}},
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-2", dag=dag, start_ids=["model"])

    await FlowResumeTask.handle_resume(
        database,
        redis_client=FakeRedis(),
        run_id="run-2",
        publisher=publisher,
    )

    assert FakeAITaskClient.requests[0]["options"]["inputs"] == {
        "upstream": {"asset": "selected-image"}
    }
    assert FakeAITaskClient.requests[0]["webhook_url"].endswith(
        "/callbacks/models/opencreator_ai"
    )
    assert FakeAITaskClient.requests[0]["idempotency_key"]
    assert FakeAITaskClient.requests[0]["client_context"]["run_id"] == "run-2"
    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-2", "node_id": "model"}
    )
    assert model_doc is not None
    assert model_doc["status"] == "running"
    assert model_doc["expected_result_ids"]
    assert model_doc["execution_plans"][0]["result_id"] == model_doc["expected_result_ids"][0]
    invocation = await database["model_invocations"].find_one({"ai_task_id": "ai-task-1"})
    assert invocation is not None
    assert invocation["trace_id"] is None
    assert invocation["idempotency_key"] == FakeAITaskClient.requests[0]["idempotency_key"]
    assert invocation["provider_gateway_status"] == "queued"
    assert invocation["client_context"]["node_id"] == "model"


@pytest.mark.asyncio
async def test_model_planner_reuses_existing_execution_plan() -> None:
    database = FakeDatabase()
    node_doc = {
        "node_data": node("model", "imageModel", {"selectedModels": ["m1"]}),
        "node_id": "model",
        "node_type": "imageModel",
        "run_id": "run-3",
        "status": "idle",
    }
    await database[FlowNodeStateService.COLLECTION].insert_one(node_doc)

    first = await ModelInvocationPlanner.plan_node(
        database,
        run_id="run-3",
        node=node_doc,
        inputs={"input": {"text": "hello"}},
    )
    stored = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-3", "node_id": "model"}
    )
    assert stored is not None

    second = await ModelInvocationPlanner.plan_node(
        database,
        run_id="run-3",
        node=stored,
        inputs={"input": {"text": "changed"}},
    )

    assert second.result_id == first.result_id
    assert second.execution_plan_token == first.execution_plan_token
    assert second.execution_plans == first.execution_plans


@pytest.mark.asyncio
async def test_callback_aggregation_marks_success_and_resumes_successor() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-4",
        flow_task_id="task-4",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-4",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-4", dag=dag)
    await FlowNodeStateService.set_expected_result(
        database,
        run_id="run-4",
        node_id="model",
        result_id="result-1",
        execution_plan_token="plan-1",
    )
    await FlowNodeStateService.set_status(
        database, run_id="run-4", node_id="model", status="running"
    )
    invocation = {
        "_id": "inv-1",
        "node_id": "model",
        "result": {"formatted_output": {"url": "image.png"}},
        "result_id": "result-1",
        "run_id": "run-4",
        "status": "success",
    }
    await database["model_invocations"].insert_one(invocation)

    await NodeAggregationService.aggregate_invocation(
        database,
        redis_client=FakeRedis(),
        publisher=publisher,
        invocation=invocation,
    )

    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-4", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-4", "node_id": "next"}
    )
    assert model_doc["status"] == "success"
    assert next_doc["status"] == "success"
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert event_types.count("node_status") >= 2


@pytest.mark.asyncio
async def test_callback_aggregation_marks_select_for_multiple_candidates() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-5",
        flow_task_id="task-5",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-5",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-5", dag=dag)
    await FlowNodeStateService.set_expected_result(
        database,
        run_id="run-5",
        node_id="model",
        result_id="result-1",
        execution_plan_token="plan-1",
    )
    await FlowNodeStateService.set_status(
        database, run_id="run-5", node_id="model", status="running"
    )
    invocation = {
        "_id": "inv-2",
        "node_id": "model",
        "result": {"formatted_output": [{"url": "a.png"}, {"url": "b.png"}]},
        "result_id": "result-1",
        "run_id": "run-5",
        "status": "success",
    }
    await database["model_invocations"].insert_one(invocation)

    await NodeAggregationService.aggregate_invocation(
        database, publisher=publisher, invocation=invocation
    )

    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-5", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-5", "node_id": "next"}
    )
    assert model_doc["status"] == "select"
    assert next_doc["status"] == "idle"


@pytest.mark.asyncio
async def test_callback_aggregation_marks_failed_and_stops_descendants() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-6",
        flow_task_id="task-6",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-6",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-6", dag=dag)
    await FlowNodeStateService.set_expected_result(
        database,
        run_id="run-6",
        node_id="model",
        result_id="result-1",
        execution_plan_token="plan-1",
    )
    await FlowNodeStateService.set_status(
        database, run_id="run-6", node_id="model", status="running"
    )
    invocation = {
        "_id": "inv-3",
        "node_id": "model",
        "result_id": "result-1",
        "run_id": "run-6",
        "status": "failed",
    }
    await database["model_invocations"].insert_one(invocation)

    await NodeAggregationService.aggregate_invocation(
        database, publisher=publisher, invocation=invocation
    )

    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-6", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-6", "node_id": "next"}
    )
    assert model_doc["status"] == "failed"
    assert next_doc["status"] == "stopped"


@pytest.mark.asyncio
async def test_continue_restores_select_node_and_resumes_successor() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-7",
        flow_task_id="task-7",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-start-7",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-7", dag=dag)
    await FlowNodeStateService.set_status(
        database, run_id="run-7", node_id="model", status="select"
    )
    payload = {
        "command_id": "cmd-continue-7",
        "dag": dag,
        "flow_run_id": "run-7",
        "flow_run_type": "continue",
        "flow_task_id": "task-7",
        "protocol_version": 2,
        "reply_queue": "reply",
        "trace_id": "trace-7",
        "user_id": "user-1",
        "user_selection": {"model": {"asset": "chosen-image"}},
    }

    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=FakeRedis())

    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-7", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-7", "node_id": "next"}
    )
    assert model_doc["status"] == "success"
    assert model_doc["selected_outputs"] == {"asset": "chosen-image"}
    assert next_doc["status"] == "success"


@pytest.mark.asyncio
async def test_cancel_command_stops_active_nodes_and_publishes_flow_killed() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-8",
        flow_task_id="task-8",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-start-8",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-8", dag=dag)
    await FlowNodeStateService.set_status(
        database, run_id="run-8", node_id="model", status="running"
    )
    payload = {
        "command_id": "cmd-cancel-8",
        "dag": dag,
        "flow_run_id": "run-8",
        "flow_run_type": "cancel",
        "flow_task_id": "task-8",
        "protocol_version": 2,
        "reply_queue": "reply",
        "trace_id": "trace-8",
        "user_id": "user-1",
    }

    await FlowTask.run_flow(database, payload, publisher=publisher)
    await FlowTask.run_flow(database, payload, publisher=publisher)

    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-8"})
    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-8", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-8", "node_id": "next"}
    )
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert run["status"] == "killed"
    assert run["cancel_command_id"] == "cmd-cancel-8"
    assert model_doc["status"] == "stopped"
    assert next_doc["status"] == "stopped"
    assert event_types.count("flow_killed") == 1


@pytest.mark.asyncio
async def test_consumer_outbox_covers_workflow_v2_event_types_and_dedupes() -> None:
    database = FakeDatabase()
    publisher = ObservingPublisher(database)
    event_types = [
        "start_flow",
        "node_status",
        "start_running_llm_models",
        "llm_model_ready",
        "llm_model_status",
        "finish_running_llm_models",
        "finish_flow",
        "flow_killed",
        "workflow_error",
    ]

    for event_type in event_types:
        await FlowEventPublishService.publish(
            database,
            publisher,
            queue_name="reply",
            flow_task_id="task-outbox",
            flow_run_id="run-outbox",
            command_id="cmd-outbox",
            event_type=event_type,
            event_id=FlowEventPublishService.stable_event_id(event_type, "run-outbox"),
            payload={"event_type": event_type},
        )

    duplicate_event_id = FlowEventPublishService.stable_event_id("node_status", "dedupe")
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-outbox",
        flow_run_id="run-outbox",
        command_id="cmd-outbox",
        event_type="node_status",
        event_id=duplicate_event_id,
        payload={"status": "success"},
    )
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-outbox",
        flow_run_id="run-outbox",
        command_id="cmd-outbox",
        event_type="node_status",
        event_id=duplicate_event_id,
        payload={"status": "success"},
    )

    outbox_docs = list(database[FlowEventPublishService.COLLECTION].docs.values())
    published_event_ids = [message["payload"]["event_id"] for message in publisher.messages]
    assert {doc["event"]["event_type"] for doc in outbox_docs} >= set(event_types)
    assert all(doc["status"] == "sent" for doc in outbox_docs)
    assert all(doc.get("expires_at") for doc in outbox_docs)
    assert published_event_ids.count(duplicate_event_id) == 1
    assert duplicate_event_id.startswith("wfe_")


class FakeMongo:
    def __init__(self, database: FakeDatabase) -> None:
        self.database = database

    def __getitem__(self, name: str) -> FakeDatabase:
        del name
        return self.database


class FakeConnections:
    def __init__(self, database: FakeDatabase, redis: FakeRedis | None = None) -> None:
        self.mongo = FakeMongo(database)
        self.redis = redis or FakeRedis()


def _signed_callback_headers(secret: str, body: str, idempotency_key: str) -> dict[str, str]:
    timestamp = datetime.now(UTC).isoformat()
    signature = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + body.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "content-type": "application/json",
        "x-oc-idempotency-key": idempotency_key,
        "x-oc-signature": signature,
        "x-oc-timestamp": timestamp,
    }


@pytest.mark.asyncio
async def test_model_callback_rejects_invalid_signature() -> None:
    settings = get_settings()
    original_secret = settings.consumer_webhook_secret
    settings.consumer_webhook_secret = "callback-secret"
    app = create_app()
    body = json.dumps({"ai_task_id": "ai-task-invalid"})
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/callbacks/models/opencreator_ai",
                content=body,
                headers={
                    "x-oc-idempotency-key": "callback-ai-task-invalid-1",
                    "x-oc-signature": "bad",
                    "x-oc-timestamp": datetime.now(UTC).isoformat(),
                },
            )
    finally:
        settings.consumer_webhook_secret = original_secret

    assert response.status_code == 401
    assert response.json()["status"] == "invalid_signature"


@pytest.mark.asyncio
async def test_model_callback_matches_invocation_and_dedupes_replay() -> None:
    settings = get_settings()
    original_secret = settings.consumer_webhook_secret
    settings.consumer_webhook_secret = "callback-secret"
    database = FakeDatabase()
    publisher = FakePublisher()
    app = create_app()
    app.state.connections = FakeConnections(database)
    app.state.callback_publisher = publisher
    dag = {
        "nodes": [node("model", "imageModel"), node("next", "textInput")],
        "edges": [{"source": "model", "target": "next"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-callback",
        flow_task_id="task-callback",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-callback",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-callback", dag=dag)
    await FlowNodeStateService.set_expected_result(
        database,
        run_id="run-callback",
        node_id="model",
        result_id="result-callback",
        execution_plan_token="plan-callback",
    )
    await FlowNodeStateService.set_status(
        database,
        run_id="run-callback",
        node_id="model",
        status="running",
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-callback",
            "ai_task_id": "ai-task-callback",
            "client_context": {
                "node_id": "model",
                "result_id": "result-callback",
                "run_id": "run-callback",
            },
            "node_id": "model",
            "result_id": "result-callback",
            "run_id": "run-callback",
            "status": "queued",
        }
    )
    payload = {
        "ai_task_id": "ai-task-callback",
        "status": "success",
        "model_id": "accept-image",
        "client_context": {
            "node_id": "model",
            "result_id": "result-callback",
            "run_id": "run-callback",
        },
        "result": {"formatted_output": {"url": "image.png"}},
        "error": None,
        "started_at": "2026-09-28T13:00:00.000Z",
        "completed_at": "2026-09-28T13:00:03.000Z",
    }
    body = json.dumps(payload, separators=(",", ":"))
    headers = _signed_callback_headers(
        settings.consumer_webhook_secret,
        body,
        "callback-ai-task-callback-1",
    )

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.post(
                "/callbacks/models/opencreator_ai",
                content=body,
                headers=headers,
            )
            published_once = len(publisher.messages)
            second = await client.post(
                "/callbacks/models/opencreator_ai",
                content=body,
                headers=headers,
            )
    finally:
        settings.consumer_webhook_secret = original_secret

    assert first.status_code == 200
    assert first.json()["matched"] is True
    assert second.status_code == 200
    assert len(publisher.messages) == published_once
    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"ai_task_id": "ai-task-callback"}
    )
    model_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-callback", "node_id": "model"}
    )
    next_doc = await database[FlowNodeStateService.COLLECTION].find_one(
        {"run_id": "run-callback", "node_id": "next"}
    )
    assert invocation is not None
    assert invocation["status"] == "success"
    assert invocation["callback_dedupe_keys"] == ["callback-ai-task-callback-1"]
    assert invocation["result"] == {"formatted_output": {"url": "image.png"}}
    assert model_doc["status"] == "success"
    assert next_doc["status"] == "success"


def _start_payload(command_id: str, run_id: str, dag: dict[str, Any]) -> dict[str, Any]:
    return {
        "command_id": command_id,
        "dag": dag,
        "flow_run_id": run_id,
        "flow_run_type": "start",
        "flow_task_id": f"task-{run_id}",
        "protocol_version": 2,
        "reply_queue": "reply",
        "start_ids": ["input"],
        "trace_id": f"trace-{run_id}",
        "user_id": "user-1",
        "user_selection": {},
    }


@pytest.mark.asyncio
async def test_same_start_message_initializes_run_once(monkeypatch: pytest.MonkeyPatch) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    redis = FakeRedis()
    dag = {"nodes": [node("input", "textInput")], "edges": []}
    calls: list[str] = []
    original = FlowRunStateService.init_flow_run

    async def counting(*args: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append(str(kwargs["run_id"]))
        return await original(*args, **kwargs)

    monkeypatch.setattr(FlowRunStateService, "init_flow_run", counting)
    payload = _start_payload("cmd-once", "run-once", dag)

    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)

    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-once"})
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert calls == ["run-once"]
    assert run is not None
    assert run["start_initialized"] is True
    assert event_types.count("start_flow") == 1
    assert redis.sets[0]["key"] == f"{FLOW_START_LOCK_PREFIX}run-once"
    assert redis.sets[0]["nx"] is True
    assert redis.sets[0]["ex"] == get_settings().flow_start_lock_ttl_seconds


@pytest.mark.asyncio
async def test_start_crash_before_init_nodes_leaves_inbox_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {"nodes": [node("input", "textInput")], "edges": []}
    original = FlowRunStateService.init_flow_run

    async def init_then_die(*args: Any, **kwargs: Any) -> dict[str, Any]:
        await original(*args, **kwargs)
        raise RuntimeError("died before init_nodes")

    monkeypatch.setattr(FlowRunStateService, "init_flow_run", init_then_die)
    payload = _start_payload("cmd-die", "run-die", dag)

    with pytest.raises(RuntimeError, match="died before init_nodes"):
        await FlowTask.run_flow(
            database,
            payload,
            publisher=publisher,
            redis_client=FakeRedis(),
        )

    inbox = await database["flow_command_inbox"].find_one({"_id": "cmd-die"})
    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-die"})
    nodes = await FlowNodeStateService.list_nodes(database, "run-die")
    assert inbox is not None
    assert inbox["status"] == "failed"
    assert "expires_at" not in inbox
    assert inbox["redelivery_payload"]["command_id"] == "cmd-die"
    assert run is not None
    assert run["start_initialized"] is False
    assert nodes == []
    assert publisher.messages == []


@pytest.mark.asyncio
async def test_start_lock_without_durable_run_is_retryable() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    redis = FakeRedis()
    dag = {"nodes": [node("input", "textInput")], "edges": []}
    payload = _start_payload("cmd-held", "run-held", dag)
    await redis.set(f"{FLOW_START_LOCK_PREFIX}run-held", "other-worker", ex=300)

    with pytest.raises(RuntimeError, match="start lock is held but durable run is missing"):
        await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)

    inbox = await database["flow_command_inbox"].find_one({"_id": "cmd-held"})
    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-held"})
    assert inbox is not None
    assert inbox["status"] == "failed"
    assert "expires_at" not in inbox
    assert run is None
    assert publisher.messages == []


@pytest.mark.asyncio
async def test_start_repairs_uninitialized_run_without_creating_another(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {"nodes": [node("input", "textInput", {"text": "hello"})], "edges": []}
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-repair",
        flow_task_id="task-run-repair",
        user_id="user-1",
        ws_id="",
        dag=dag,
        start_ids=["input"],
        reply_queue="reply",
        command_id="cmd-old",
        protocol_version=2,
    )

    async def fail_init(*args: Any, **kwargs: Any) -> dict[str, Any]:
        del args, kwargs
        raise AssertionError("repair must reuse the durable run")

    monkeypatch.setattr(FlowRunStateService, "init_flow_run", fail_init)
    payload = _start_payload("cmd-repair", "run-repair", dag)
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=FakeRedis())

    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-repair"})
    nodes = await FlowNodeStateService.list_nodes(database, "run-repair")
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    inbox = await database["flow_command_inbox"].find_one({"_id": "cmd-repair"})
    assert run is not None
    assert run["start_initialized"] is True
    assert len(nodes) == 1
    assert event_types.count("start_flow") == 1
    assert inbox is not None
    assert inbox["status"] == "completed"


@pytest.mark.asyncio
async def test_start_already_initialized_does_not_bootstrap_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {"nodes": [node("input", "textInput")], "edges": []}
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-ready",
        flow_task_id="task-run-ready",
        user_id="user-1",
        ws_id="",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-old",
        protocol_version=2,
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-ready", dag=dag)
    await FlowRunStateService.mark_start_initialized(database, "run-ready")

    async def fail_nodes(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise AssertionError("initialized run must not lay nodes again")

    monkeypatch.setattr(FlowNodeStateService, "init_nodes", fail_nodes)
    payload = _start_payload("cmd-ready", "run-ready", dag)
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=FakeRedis())

    inbox = await database["flow_command_inbox"].find_one({"_id": "cmd-ready"})
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert inbox is not None
    assert inbox["status"] == "completed"
    assert "start_flow" not in event_types


@pytest.mark.asyncio
async def test_cancel_during_node_bootstrap_kills_without_start_flow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [node("input", "textInput"), node("next", "textInput")],
        "edges": [{"source": "input", "target": "next"}],
    }
    original = FlowNodeStateService.init_nodes

    async def init_then_cancel(database_arg: Any, **kwargs: Any) -> None:
        await original(database_arg, **kwargs)
        await database_arg[FlowRunStateService.COLLECTION].update_one(
            {"run_id": kwargs["run_id"]},
            {"$set": {"cancel_requested": True}},
        )

    monkeypatch.setattr(FlowNodeStateService, "init_nodes", init_then_cancel)
    payload = _start_payload("cmd-cancel-race", "run-cancel-race", dag)
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=FakeRedis())

    run = await database[FlowRunStateService.COLLECTION].find_one({"run_id": "run-cancel-race"})
    inbox = await database["flow_command_inbox"].find_one({"_id": "cmd-cancel-race"})
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert run is not None
    assert run["status"] == "killed"
    assert run["start_initialized"] is False
    assert inbox is not None
    assert inbox["status"] == "completed"
    assert "start_flow" not in event_types
    assert "flow_killed" in event_types


@pytest.mark.asyncio
async def test_start_seeds_inactive_node_outputs_without_changing_status() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [
            node("upstream", "imageInput"),
            node("input", "textInput"),
        ],
        "edges": [{"source": "upstream", "target": "input"}],
    }
    payload = _start_payload("cmd-seed", "run-seed", dag)
    payload["user_selection"] = {
        "upstream": {"asset": "kept"},
        "input": {"asset": "do-not-seed"},
    }

    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=FakeRedis())

    upstream = await FlowNodeStateService.get_node(database, "run-seed", "upstream")
    active = await FlowNodeStateService.get_node(database, "run-seed", "input")
    assert upstream is not None
    assert upstream["is_active"] is False
    assert upstream["status"] == "idle"
    assert upstream["selected_outputs"] == {"asset": "kept"}
    assert active is not None
    assert active.get("selected_outputs") != {"asset": "do-not-seed"}


@pytest.mark.asyncio
async def test_concurrent_transition_status_allows_one_winner() -> None:
    database = FakeDatabase()
    await database[FlowNodeStateService.COLLECTION].insert_one(
        {"node_id": "n1", "run_id": "run-cas", "status": "idle"}
    )

    results = await asyncio.gather(
        FlowNodeStateService.transition_status(
            database,
            run_id="run-cas",
            node_id="n1",
            from_statuses=["idle"],
            status="running",
        ),
        FlowNodeStateService.transition_status(
            database,
            run_id="run-cas",
            node_id="n1",
            from_statuses=["idle"],
            status="running",
        ),
    )

    stored = await FlowNodeStateService.get_node(database, "run-cas", "n1")
    missed = await FlowNodeStateService.transition_status(
        database,
        run_id="run-cas",
        node_id="n1",
        from_statuses=["idle"],
        status="running",
    )
    assert results.count(True) == 1
    assert results.count(False) == 1
    assert missed is False
    assert stored is not None
    assert stored["status"] == "running"


@pytest.mark.asyncio
async def test_concurrent_handle_resume_enters_once(monkeypatch: pytest.MonkeyPatch) -> None:
    entered: list[str] = []
    redis = FakeRedis()

    async def once(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        entered.append("in")
        await asyncio.sleep(0)

    monkeypatch.setattr(FlowResumeTask, "_resume_once", once)
    await asyncio.gather(
        FlowResumeTask.handle_resume(
            object(),
            redis_client=redis,
            run_id="run-lock",
            publisher=object(),
            reason="start",
        ),
        FlowResumeTask.handle_resume(
            object(),
            redis_client=redis,
            run_id="run-lock",
            publisher=object(),
            reason="start",
        ),
    )

    assert entered == ["in"]
    assert redis.sets[0]["key"] == f"{FLOW_RESUME_LOCK_PREFIX}run-lock"
    assert redis.sets[0]["nx"] is True
    assert redis.sets[0]["ex"] == get_settings().flow_resume_lock_ttl_seconds
    assert f"{FLOW_RESUME_LOCK_PREFIX}run-lock" not in redis.values


@pytest.mark.asyncio
async def test_resume_lock_release_checks_token(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = FakeRedis()
    lock_key = f"{FLOW_RESUME_LOCK_PREFIX}run-owner"

    async def steal(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        await redis.set(lock_key, "next-owner", ex=300)

    monkeypatch.setattr(FlowResumeTask, "_resume_once", steal)
    await FlowResumeTask.handle_resume(
        object(),
        redis_client=redis,
        run_id="run-owner",
        publisher=object(),
        reason="start",
    )

    assert redis.values[lock_key] == "next-owner"


class _BytesRedis(FakeRedis):
    async def get(self, key: str) -> bytes | None:
        value = self.values.get(key)
        return None if value is None else value.encode()


@pytest.mark.asyncio
async def test_resume_lock_owner_deletes_byte_token(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = _BytesRedis()
    entered: list[int] = []

    async def once(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        entered.append(1)

    monkeypatch.setattr(FlowResumeTask, "_resume_once", once)
    await FlowResumeTask.handle_resume(
        object(),
        redis_client=redis,
        run_id="run-bytes",
        publisher=object(),
        reason="start",
    )
    await FlowResumeTask.handle_resume(
        object(),
        redis_client=redis,
        run_id="run-bytes",
        publisher=object(),
        reason="start",
    )

    assert entered == [1, 1]
    assert f"{FLOW_RESUME_LOCK_PREFIX}run-bytes" not in redis.values


@pytest.mark.asyncio
async def test_outbox_sent_or_live_lease_publishes_once_and_expired_lease_retries() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    event_id = FlowEventPublishService.stable_event_id("node_status", "lease")

    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        trace_id="trace-lease",
        payload={"status": "running"},
    )
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        payload={"status": "running"},
    )

    stored = next(iter(database[FlowEventPublishService.COLLECTION].docs.values()))
    assert len(publisher.messages) == 1
    assert stored["status"] == "sent"
    assert stored["payload"]["trace_id"] == "trace-lease"
    assert stored["payload"]["run_id"] == "run-lease"
    assert stored["payload"]["protocol_version"] == 2

    stored["status"] = "publishing"
    stored["publish_lease_token"] = "live"
    stored["publish_lease_expires_at"] = datetime.now(UTC) + timedelta(seconds=30)
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        payload={"status": "running"},
    )
    assert len(publisher.messages) == 1

    stored["publish_lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        payload={"status": "running"},
    )
    assert len(publisher.messages) == 2
    refreshed = await database[FlowEventPublishService.COLLECTION].find_one({"event_id": event_id})
    assert refreshed is not None
    assert refreshed["status"] == "sent"


@pytest.mark.asyncio
async def test_replay_due_outbox_events_sends_pending_once() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    event_id = FlowEventPublishService.stable_event_id("finish_flow", "replay")
    await database[FlowEventPublishService.COLLECTION].insert_one(
        {
            "_id": event_id,
            "created_at": datetime.now(UTC),
            "event_id": event_id,
            "payload": {"event_id": event_id, "event_type": "finish_flow"},
            "queue_name": "reply",
            "status": "pending",
        }
    )

    replayed = await FlowEventPublishService.replay_due_events(database, publisher)
    again = await FlowEventPublishService.replay_due_events(database, publisher)

    stored = await database[FlowEventPublishService.COLLECTION].find_one({"event_id": event_id})
    assert replayed == 1
    assert again == 0
    assert len(publisher.messages) == 1
    assert stored is not None
    assert stored["status"] == "sent"


@pytest.mark.asyncio
async def test_unmatched_callback_stays_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    del monkeypatch
    settings = get_settings()
    original_secret = settings.consumer_webhook_secret
    settings.consumer_webhook_secret = "callback-secret"
    database = FakeDatabase()
    app = create_app()
    app.state.connections = FakeConnections(database)
    app.state.callback_publisher = FakePublisher()
    payload = {
        "ai_task_id": "missing-task",
        "status": "success",
        "model_id": "accept-image",
        "result": {"formatted_output": {"url": "image.png"}},
        "error": None,
        "started_at": "2026-09-28T13:00:00.000Z",
        "completed_at": "2026-09-28T13:00:03.000Z",
    }
    body = json.dumps(payload, separators=(",", ":"))
    headers = _signed_callback_headers(settings.consumer_webhook_secret, body, "missing-1")

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/callbacks/models/opencreator_ai",
                content=body,
                headers=headers,
            )
    finally:
        settings.consumer_webhook_secret = original_secret

    pending = await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].find_one(
        {"external_task_id": "missing-task", "vendor": "opencreator_ai"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["matched"] is False
    assert response.json()["finalize_scheduled"] is False
    assert pending is not None
    assert pending["status"] == "pending"


@pytest.mark.asyncio
async def test_callback_fast_attaches_trace_id_before_pending() -> None:
    database = FakeDatabase()
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "invocation_id": "result-trace",
            "node_id": "model",
            "result_id": "result-trace",
            "run_id": "run-trace",
            "status": "submitting",
            "trace_id": "trace-callback",
        }
    )

    matched = await ModelInvocationService.handle_callback_fast(
        database,
        vendor="opencreator_ai",
        payload={
            "ai_task_id": "ai-from-callback",
            "status": "success",
            "trace_id": "trace-callback",
            "result": {"formatted_output": {"url": "traced.png"}},
        },
        idempotency_key="delivery-1",
    )

    assert matched is not None
    assert matched["_schedule_finalize"] is True
    assert matched["external_task_id"] == "ai-from-callback"
    pending = await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].find_one(
        {"external_task_id": "ai-from-callback"}
    )
    assert pending is None


@pytest.mark.asyncio
async def test_finalize_claim_loss_does_not_write_results() -> None:
    database = FakeDatabase()
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-claimed",
            "callback_result": {"formatted_output": {"url": "new.png"}},
            "callback_status": "success",
            "finalize_status": "running",
            "invocation_id": "inv-claimed",
            "node_id": "model",
            "result": {"kept": True},
            "result_id": "result-claimed",
            "run_id": "run-claimed",
            "status": "running",
        }
    )

    current = await InvocationFinalizer.run_finalize(
        database,
        redis_client=None,
        publisher=FakePublisher(),
        invocation_id="inv-claimed",
    )

    stored = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-claimed"}
    )
    assert current is not None
    assert stored is not None
    assert stored["result"] == {"kept": True}
    assert stored["finalize_status"] == "running"


@pytest.mark.asyncio
async def test_submit_timeout_keeps_the_same_result_id(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(self: Any, request: Any) -> None:
        del self, request
        raise OpenCreatorAISubmitError("AI task submit request timed out")

    monkeypatch.setattr(OpenCreatorAIProvider, "submit", boom)
    database = FakeDatabase()
    await database[FlowNodeStateService.COLLECTION].insert_one(
        {
            "execution_claim_token": "claim-1",
            "execution_plan_token": "plan-1",
            "execution_plans": [{"model_id": "default", "result_id": "result-timeout"}],
            "expected_result_ids": ["result-timeout"],
            "node_id": "model",
            "run_id": "run-timeout",
            "status": "running",
        }
    )
    plan = ModelInvocationPlan(
        execution_plan_token="plan-1",
        execution_plans=[{"model_id": "default", "result_id": "result-timeout"}],
        result_id="result-timeout",
    )

    await ModelInvocationService.submit_planned_node(
        database,
        flow={"run_id": "run-timeout", "user_id": "user-1"},
        node={"node_id": "model", "node_type": "imageModel", "node_data": {"data": {}}},
        plan=plan,
        execution_claim_token="claim-1",
        inputs={"upstream": {"asset": "kept"}},
    )

    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "result-timeout"}
    )
    node_doc = await FlowNodeStateService.get_node(database, "run-timeout", "model")
    reused = await ModelInvocationPlanner.plan_node(
        database,
        run_id="run-timeout",
        node=node_doc or {},
        inputs={},
    )
    assert invocation is not None
    assert invocation["result_id"] == "result-timeout"
    assert invocation["submit_status"] == "uncertain"
    assert invocation["status"] == "running"
    assert len(database[ModelInvocationService.COLLECTION].docs) == 1
    assert reused.result_id == "result-timeout"


_AGENT_SRC = Path(__file__).resolve().parents[2] / "novelcomic-agent" / "src"


class _StreamRedis:
    def __init__(self) -> None:
        self.messages: list[tuple[str, dict[str, Any]]] = []

    async def xadd(self, queue_name: str, message: dict[str, Any]) -> str:
        self.messages.append((queue_name, dict(message)))
        return f"{len(self.messages)}-0"


@pytest.mark.asyncio
async def test_agent_run_flow_publish_is_gated_by_consumer_inbox() -> None:
    sys.path.insert(0, str(_AGENT_SRC))
    from novelcomic_agent.workflow.task_publisher import run_flow

    stream = _StreamRedis()
    payload = {
        "command_id": "cmd-agent",
        "dag": {
            "nodes": [node("input", "textInput", {"text": "hello"})],
            "edges": [],
        },
        "flow_id": "flow-agent",
        "flow_run_id": "run-agent",
        "flow_run_type": "start",
        "flow_task_id": "task-agent",
        "protocol_version": 2,
        "reply_queue": "reply",
        "session_id": "session-agent",
        "source": "agent",
        "start_ids": ["input"],
        "trace_id": "trace-agent",
        "user_id": "user-1",
        "user_selection": {},
    }

    first_id = await run_flow.publish(payload, redis_client=stream, task_id="task-agent")
    second_id = await run_flow.publish(payload, redis_client=stream, task_id="task-agent")

    assert first_id == "1-0"
    assert second_id == "2-0"
    assert [queue_name for queue_name, _fields in stream.messages] == ["run_flow", "run_flow"]

    database = FakeDatabase()
    publisher = FakePublisher()
    redis = FakeRedis()
    decoded_messages = []
    for _queue_name, fields in stream.messages:
        decoded = decode_stream_payload(fields)
        assert decoded["source"] == "agent"
        assert decoded["command_id"] == "cmd-agent"
        assert decoded["protocol_version"] == 2
        decoded_messages.append(decoded)

    await FlowTask.run_flow(
        database,
        decoded_messages[0],
        publisher=publisher,
        redis_client=redis,
    )
    outbox_after_first = len(database[FlowEventPublishService.COLLECTION].docs)
    published_after_first = len(publisher.messages)
    await FlowTask.run_flow(
        database,
        decoded_messages[1],
        publisher=publisher,
        redis_client=redis,
    )

    assert len(database["flow_command_inbox"].docs) == 1
    assert len(database[FlowEventPublishService.COLLECTION].docs) == outbox_after_first
    assert len(publisher.messages) == published_after_first
    event_types = [message["payload"]["event_type"] for message in publisher.messages]
    assert event_types.count("start_flow") == 1


@pytest.mark.asyncio
async def test_multi_model_planner_and_continue_selected_outputs_priority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    dag = {
        "nodes": [
            node("maker", "imageModel", {"selectedModels": ["z-image", "gpt-image-2"]}),
            node("downstream", "imageModel", {"selectedModels": ["z-image"]}),
        ],
        "edges": [{"source": "maker", "target": "downstream"}],
    }
    await FlowRunStateService.init_flow_run(
        database,
        run_id="run-multi",
        flow_task_id="task-multi",
        user_id="user-1",
        ws_id="ws-1",
        dag=dag,
        reply_queue="reply",
        command_id="cmd-multi",
    )
    await FlowNodeStateService.init_nodes(database, run_id="run-multi", dag=dag)

    maker_doc = await FlowNodeStateService.get_node(database, "run-multi", "maker")
    assert maker_doc is not None
    plan = await ModelInvocationPlanner.plan_node(
        database,
        run_id="run-multi",
        node=maker_doc,
        inputs={},
    )
    assert len(plan.execution_plans) == 2
    assert len(plan.expected_result_ids) == 2
    assert [item["model_id"] for item in plan.execution_plans] == ["z-image", "gpt-image-2"]

    await database[FlowNodeStateService.COLLECTION].update_one(
        {"run_id": "run-multi", "node_id": "maker"},
        {
            "$set": {
                "status": "select",
                "outputs": {
                    "image": {
                        "type": "image",
                        "outputs": [
                            {"url": "https://cdn.example/all-1.png", "result_id": "r1"},
                            {"url": "https://cdn.example/all-2.png", "result_id": "r2"},
                        ],
                    }
                },
            }
        },
    )

    captured_inputs: list[dict[str, Any]] = []

    async def fake_submit_planned_node(
        _database: Any,
        *,
        redis_client: Any | None = None,
        flow: dict[str, Any],
        node: dict[str, Any],
        plan: ModelInvocationPlan,
        execution_claim_token: str,
        inputs: dict[str, Any],
    ) -> None:
        del _database, redis_client, flow, node, plan, execution_claim_token
        captured_inputs.append(inputs)

    monkeypatch.setattr(ModelInvocationService, "submit_planned_node", fake_submit_planned_node)

    chosen = {
        "image": {
            "type": "image",
            "outputs": [{"url": "https://cdn.example/all-2.png", "result_id": "r2"}],
        }
    }
    await FlowTask.run_flow(
        database,
        {
            "command_id": "cmd-multi-continue",
            "dag": dag,
            "flow_run_id": "run-multi",
            "flow_run_type": "continue",
            "flow_task_id": "task-multi",
            "protocol_version": 2,
            "reply_queue": "reply",
            "start_ids": ["maker"],
            "user_id": "user-1",
            "user_selection": {"maker": chosen},
        },
        publisher=publisher,
        redis_client=FakeRedis(),
    )

    assert len(captured_inputs) == 1
    assert captured_inputs[0]["maker"] == chosen

