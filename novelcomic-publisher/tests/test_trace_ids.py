"""HTTP trace、run trace，以及事件连接自己的 trace。"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import Response

from app.common.context.request_context import RequestContext, trace_id_context
from app.controller.v2.flow_runs import workflow_run_events
from app.core.register import register_middleware
from app.main import create_app
from app.middleware.trace_id_middlewares import TraceIDMiddleware
from app.schemas.workflow_runs_v2 import ContinueWorkflowRunRequest, CreateWorkflowRunRequest
from app.services.flow import FlowService
from app.services.workflow_runs_v2 import WorkflowRunV2Service
from app.utils.id_utils import generate_trace_id
from tests.test_workflow_runs_v2_continue import FakeDatabase, FakeRedis

TRACE_ID = re.compile(r"^1-[0-9a-f]{8}-[0-9a-f]{24}$")


def test_generate_trace_id_uses_version_timestamp_and_random_bits() -> None:
    first = generate_trace_id()
    second = generate_trace_id()

    assert TRACE_ID.fullmatch(first)
    assert TRACE_ID.fullmatch(second)
    assert first != second


def test_request_context_defaults_to_dash() -> None:
    token = trace_id_context.set(None)
    try:
        assert RequestContext.get_trace_id() == "-"
        RequestContext.set_trace_id("trace-set")
        assert RequestContext.get_trace_id() == "trace-set"
    finally:
        trace_id_context.reset(token)


def test_publisher_registers_trace_middleware() -> None:
    app = FastAPI()
    register_middleware(app)
    assert TraceIDMiddleware in {item.cls for item in app.user_middleware}
    assert TraceIDMiddleware in {item.cls for item in create_app().user_middleware}


def test_http_trace_is_fresh_and_ignores_the_inbound_header() -> None:
    app = FastAPI()
    app.add_middleware(TraceIDMiddleware)

    @app.get("/ping")
    async def ping(request: Request) -> dict[str, str]:
        return {"state": request.state.trace_id}

    with TestClient(app) as client:
        first = client.get("/ping", headers={"X-Trace-ID": "inbound-trace"})
        second = client.get("/ping", headers={"X-Trace-ID": "inbound-trace"})

    assert first.status_code == 200
    assert second.status_code == 200
    first_id = first.headers["X-Trace-ID"]
    second_id = second.headers["X-Trace-ID"]
    assert first_id == first.json()["state"]
    assert TRACE_ID.fullmatch(first_id)
    assert TRACE_ID.fullmatch(second_id)
    assert first_id != second_id
    assert first_id != "inbound-trace"
    assert second_id != "inbound-trace"


def test_publisher_health_and_unauthorized_routes_carry_trace_headers() -> None:
    with TestClient(create_app()) as client:
        health = client.get("/health", headers={"X-Trace-ID": "inbound-trace"})
        denied = client.get("/api/v2/user/info", headers={"X-Trace-ID": "inbound-trace"})

    assert health.status_code == 200
    assert denied.status_code == 401
    assert TRACE_ID.fullmatch(health.headers["X-Trace-ID"])
    assert TRACE_ID.fullmatch(denied.headers["X-Trace-ID"])
    assert health.headers["X-Trace-ID"] != "inbound-trace"
    assert denied.headers["X-Trace-ID"] != "inbound-trace"
    assert health.headers["X-Trace-ID"] != denied.headers["X-Trace-ID"]


def test_sentry_failure_still_returns_the_trace_header(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenSentry:
        @staticmethod
        def set_tag(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("sentry sdk is not ready")

        @staticmethod
        def set_context(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("sentry sdk is not ready")

    monkeypatch.setitem(sys.modules, "sentry_sdk", BrokenSentry())
    app = FastAPI()
    app.add_middleware(TraceIDMiddleware)

    @app.get("/ping")
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        response = client.get("/ping")

    assert response.status_code == 200
    assert TRACE_ID.fullmatch(response.headers["X-Trace-ID"])


class _DisconnectRequest:
    def __init__(self, *, disconnected: bool) -> None:
        self.state = SimpleNamespace()
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


async def _no_response(_request: Any) -> Response:
    raise RuntimeError("No response returned.")


@pytest.mark.asyncio
async def test_disconnected_client_without_a_response_becomes_204() -> None:
    response = await TraceIDMiddleware(app=None).dispatch(
        _DisconnectRequest(disconnected=True),
        _no_response,
    )
    assert response.status_code == 204


@pytest.mark.asyncio
async def test_active_client_without_a_response_is_not_swallowed() -> None:
    with pytest.raises(RuntimeError, match="No response returned"):
        await TraceIDMiddleware(app=None).dispatch(
            _DisconnectRequest(disconnected=False),
            _no_response,
        )


def _start_request(command_id: str) -> CreateWorkflowRunRequest:
    return CreateWorkflowRunRequest(
        client_request_id=command_id,
        command_id=command_id,
        flow_id="flow-1",
        flow_task={"nodes": [{"id": "n"}], "edges": []},
    )


def _published_body(redis: FakeRedis) -> dict[str, Any]:
    return json.loads(redis.messages[0]["message"]["payload"])


@pytest.mark.asyncio
async def test_create_run_trace_is_independent_of_the_http_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def forbidden_context_read() -> str:
        raise AssertionError("create_run must not read RequestContext")

    monkeypatch.setattr(RequestContext, "get_trace_id", forbidden_context_read)
    RequestContext.set_trace_id("from-http")
    database = FakeDatabase()
    redis = FakeRedis()

    created = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=redis,
        request=_start_request("cmd-1"),
        user_id="user-a",
    )
    replay = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=redis,
        request=_start_request("cmd-1"),
        user_id="user-a",
    )

    run = await database["flow_task"].find_one({"flow_task_id": created.flow_task_id})
    command = await database["workflow_command"].find_one({"command_id": "cmd-1"})
    body = _published_body(redis)
    assert run is not None
    assert command is not None
    assert TRACE_ID.fullmatch(created.trace_id)
    assert created.trace_id != "from-http"
    assert replay.trace_id == created.trace_id
    assert run["trace_id"] == created.trace_id
    assert command["trace_id"] == created.trace_id
    assert body["trace_id"] == created.trace_id
    assert body["sentry_trace"] == ""
    assert body["sentry_baggage"] == ""
    assert isinstance(body["publish_timestamp"], int | float)


@pytest.mark.asyncio
async def test_continue_and_cancel_reuse_the_created_trace() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    dag = {"nodes": [{"id": "select", "type": "imageModel"}], "edges": []}
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "created_at": now,
            "end_ids": [],
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_task": dag,
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "start_ids": ["select"],
            "status": "waiting_for_selection",
            "trace_id": "trace-created",
            "updated_at": now,
            "user_id": "user-1",
        }
    )
    RequestContext.set_trace_id("socket-trace")

    continued = await WorkflowRunV2Service.continue_run(
        database=database,
        redis_client=redis,
        user_id="user-1",
        flow_task_id="task-1",
        request=ContinueWorkflowRunRequest(
            command_id="cmd-continue",
            flow_run_id="run-1",
            flow_task=dag,
            user_selection={"select": {"asset": "chosen"}},
        ),
    )

    assert continued.trace_id == "trace-created"
    continue_command = await database["workflow_command"].find_one({"command_id": "cmd-continue"})
    assert continue_command is not None
    assert continue_command["trace_id"] == "trace-created"
    assert _published_body(redis)["trace_id"] == "trace-created"

    await database["flow_task"].update_one(
        {"flow_task_id": "task-1"},
        {"$set": {"status": "running"}},
    )
    cancelled = await WorkflowRunV2Service.cancel_run(
        database=database,
        redis_client=redis,
        user_id="user-1",
        flow_task_id="task-1",
        command_id="cmd-cancel",
    )
    cancel_command = await database["workflow_command"].find_one({"command_id": "cmd-cancel"})
    assert cancelled.trace_id == "trace-created"
    assert cancel_command is not None
    assert cancel_command["trace_id"] == "trace-created"
    assert json.loads(redis.messages[-1]["message"]["payload"])["trace_id"] == "trace-created"


@pytest.mark.asyncio
async def test_continue_without_a_trace_generates_one_and_keeps_it() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    dag = {"nodes": [{"id": "select"}], "edges": []}
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "created_at": now,
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_task": dag,
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "waiting_for_selection",
            "updated_at": now,
            "user_id": "user-1",
        }
    )

    continued = await WorkflowRunV2Service.continue_run(
        database=database,
        redis_client=redis,
        user_id="user-1",
        flow_task_id="task-1",
        request=ContinueWorkflowRunRequest(
            command_id="cmd-continue",
            flow_run_id="run-1",
            flow_task=dag,
        ),
    )

    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    command = await database["workflow_command"].find_one({"command_id": "cmd-continue"})
    assert run is not None
    assert command is not None
    assert TRACE_ID.fullmatch(continued.trace_id)
    assert run["trace_id"] == continued.trace_id
    assert command["trace_id"] == continued.trace_id
    assert _published_body(redis)["trace_id"] == continued.trace_id


@pytest.mark.asyncio
async def test_dispatch_uses_the_command_trace_not_the_socket_context() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_task": {"nodes": [{"id": "n"}], "edges": []},
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "pending",
            "trace_id": "trace-on-run",
            "user_id": "user-1",
        }
    )
    await database["workflow_command"].insert_one(
        {
            "attempts": 0,
            "command_id": "cmd-1",
            "command_type": "start",
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "next_attempt_at": now,
            "payload": {
                "command_type": "start",
                "request": {
                    "flow_task": {"nodes": [{"id": "n"}], "edges": []},
                    "start_ids": ["n"],
                },
            },
            "status": "pending",
            "trace_id": "trace-on-command",
            "user_id": "user-1",
            "wire_command_id": "wfc_command",
        }
    )
    RequestContext.set_trace_id("socket-trace")

    assert await WorkflowRunV2Service.dispatch_command(
        database=database,
        redis_client=redis,
        user_id="user-1",
        command_id="cmd-1",
    )
    assert _published_body(redis)["trace_id"] == "trace-on-command"


@pytest.mark.asyncio
async def test_enqueue_trace_falls_back_then_copies_sentry_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SentryHeaders:
        @staticmethod
        def get_traceparent() -> str:
            return "00-sentry"

        @staticmethod
        def get_baggage() -> SimpleNamespace:
            return SimpleNamespace(serialize=lambda: "sentry-baggage")

    monkeypatch.setitem(sys.modules, "sentry_sdk", SentryHeaders())
    RequestContext.set_trace_id("context-trace")
    redis = FakeRedis()

    from_context = await FlowService.enqueue_flow_task(
        redis_client=redis,
        nodes=[{"id": "n", "type": "textInput"}],
        edges=[],
        reply_channel_id="v2:task-1",
        flow_task_id="task-1",
        flow_run_id="run-1",
    )
    blank = await FlowService.enqueue_flow_task(
        redis_client=redis,
        nodes=[{"id": "n", "type": "textInput"}],
        edges=[],
        reply_channel_id="v2:task-2",
        flow_task_id="task-2",
        flow_run_id="run-2",
        trace_id="",
    )

    assert from_context["trace_id"] == "context-trace"
    assert blank["trace_id"] == "context-trace"
    first = json.loads(redis.messages[0]["message"]["payload"])
    assert first["sentry_trace"] == "00-sentry"
    assert first["sentry_baggage"] == "sentry-baggage"
    assert isinstance(first["publish_timestamp"], int | float)

    RequestContext.set_trace_id("-")
    generated = await FlowService.enqueue_flow_task(
        redis_client=redis,
        nodes=[{"id": "n", "type": "textInput"}],
        edges=[],
        reply_channel_id="v2:task-3",
        flow_task_id="task-3",
        flow_run_id="run-3",
        trace_id="-",
    )
    assert TRACE_ID.fullmatch(generated["trace_id"])
    assert generated["trace_id"] != "context-trace"


class _Socket:
    def __init__(self, database: FakeDatabase) -> None:
        self.app = SimpleNamespace(
            state=SimpleNamespace(
                connections=SimpleNamespace(
                    mongo={"novelcomic": database},
                    redis=FakeRedis(),
                )
            )
        )
        self.sent: list[dict[str, Any]] = []
        self.closed: int | None = None

    async def accept(self) -> None:
        return None

    async def receive_json(self) -> dict[str, Any]:
        return {"event_type": "auth", "protocol_version": 2}

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000) -> None:
        self.closed = code


@pytest.mark.asyncio
async def test_event_socket_trace_does_not_replace_the_run_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "created_at": now,
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-created",
            "updated_at": now,
            "user_id": "user-1",
        }
    )
    monkeypatch.setattr(
        "app.controller.v2.flow_runs.get_settings",
        lambda: SimpleNamespace(mongo_database="novelcomic"),
    )
    RequestContext.set_trace_id("stale-socket")

    await workflow_run_events(_Socket(database), "task-1", "conn-1")

    socket_trace_id = RequestContext.get_trace_id()
    stored = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert stored is not None
    assert stored["trace_id"] == "trace-created"
    assert TRACE_ID.fullmatch(socket_trace_id)
    assert socket_trace_id not in {"trace-created", "stale-socket"}
