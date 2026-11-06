"""Consumer 入口 trace、领取延迟，以及 Sentry 过滤。"""

from __future__ import annotations

import logging
import sys
from io import StringIO
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.core.sentry import (
    before_send,
    before_send_transaction,
    init_sentry,
    traces_sampler,
)
from app.logger.logger import LOG_FORMAT, TraceIdFilter, log
from app.main import create_app
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService
from app.tasks.flow import FlowTask
from app.utils.trace_context import get_trace_id, set_trace_id


class _UpdateResult:
    matched_count = 1
    modified_count = 1


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            if key == "$or":
                if not any(FakeCollection._matches(document, item) for item in expected):
                    return False
                continue
            actual = document.get(key)
            if isinstance(expected, dict) and "$exists" in expected:
                exists = key in document and document.get(key) is not None
                if exists != bool(expected["$exists"]):
                    return False
                continue
            if actual != expected:
                return False
        return True

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return dict(document)
        return None

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        return_document: Any | None = None,
    ) -> dict[str, Any] | None:
        del return_document
        for document in self.docs:
            if self._matches(document, query):
                document.update(update.get("$set", {}))
                return dict(document)
        return None

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
    ) -> _UpdateResult:
        for document in self.docs:
            if self._matches(document, query):
                document.update(update.get("$set", {}))
                return _UpdateResult()
        if upsert:
            document = {key: value for key, value in query.items() if not key.startswith("$")}
            document.update(update.get("$setOnInsert", {}))
            document.update(update.get("$set", {}))
            self.docs.append(document)
        return _UpdateResult()


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


def _formatted(message: str) -> str:
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(TraceIdFilter())
    log.addHandler(handler)
    try:
        log.info(message)
    finally:
        log.removeHandler(handler)
    return stream.getvalue()


def test_logger_prints_trace_id_or_na() -> None:
    set_trace_id("trace-body")
    assert "[trace_id=trace-body]" in _formatted("run_flow received")
    set_trace_id(None)
    assert "[trace_id=N/A]" in _formatted("run_flow received")
    assert get_trace_id() is None


class _Metrics:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.fail = False

    def distribution(self, *args: Any, **kwargs: Any) -> None:
        if self.fail:
            raise RuntimeError("metrics down")
        self.calls.append((args, kwargs))


class _Sentry:
    def __init__(self, metrics: _Metrics) -> None:
        self.metrics = metrics
        self.continued: list[dict[str, Any]] = []
        self.started: list[Any] = []
        self.tags: dict[str, Any] = {}
        self.user: dict[str, Any] | None = None
        self.fail_continue = False

    def continue_trace(self, headers: dict[str, str], **kwargs: Any) -> dict[str, Any]:
        if self.fail_continue:
            raise RuntimeError("continue failed")
        self.continued.append({"headers": headers, **kwargs})
        return {"name": kwargs.get("name")}

    def start_transaction(self, *, transaction: Any) -> None:
        self.started.append(transaction)

    def set_tag(self, key: str, value: Any) -> None:
        self.tags[key] = value

    def set_user(self, user: dict[str, Any]) -> None:
        self.user = user


def _payload(**extra: Any) -> dict[str, Any]:
    body = {
        "command_id": "cmd-1",
        "flow_id": "flow-1",
        "flow_run_id": "run-1",
        "flow_run_type": "start",
        "flow_task_id": "task-1",
        "protocol_version": 2,
        "trace_id": "trace-body",
        "user_id": "user-1",
        "ws_id": "v2:task-1",
        "dag": {"nodes": [], "edges": []},
    }
    body.update(extra)
    return body


@pytest.mark.asyncio
async def test_run_flow_logs_message_trace_and_queue_delay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    metrics = _Metrics()
    sentry = _Sentry(metrics)
    monkeypatch.setitem(sys.modules, "sentry_sdk", sentry)
    claimed: list[str] = []

    async def claim(*_args: Any, **kwargs: Any) -> SimpleNamespace:
        claimed.append(kwargs["command_id"])
        return SimpleNamespace(claimed=False, conflict=False, document={})

    monkeypatch.setattr(FlowCommandInboxService, "claim_command", claim)
    set_trace_id("stale-request")
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.addFilter(TraceIdFilter())
    log.addHandler(handler)
    try:
        await FlowTask.run_flow(
            object(),
            _payload(publish_timestamp=1, sentry_trace="00-abc", sentry_baggage="bag"),
            publisher=object(),
        )
    finally:
        log.removeHandler(handler)

    assert get_trace_id() == "trace-body"
    assert "run_flow received" in stream.getvalue()
    assert "[trace_id=trace-body]" in stream.getvalue()
    assert claimed == ["cmd-1"]
    assert metrics.calls
    assert metrics.calls[0][0][0] == "flow.queue_delay"
    assert metrics.calls[0][1]["attributes"] == {"flow_run_type": "start"}
    assert metrics.calls[0][1]["unit"] == "second"
    assert sentry.continued[0]["op"] == "flow.run"
    assert sentry.continued[0]["name"] == "flow:task-1"
    assert sentry.started
    assert sentry.tags["trace_id"] == "trace-body"
    assert sentry.tags["flow_task_id"] == "task-1"
    assert sentry.tags["flow_id"] == "flow-1"
    assert sentry.tags["user_id"] == "user-1"
    assert sentry.tags["command_id"] == "cmd-1"
    assert sentry.tags["ws_id"] == "v2:task-1"
    assert sentry.user == {"id": "user-1"}


@pytest.mark.asyncio
async def test_missing_timestamp_skips_delay_and_task_still_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    metrics = _Metrics()
    sentry = _Sentry(metrics)
    sentry.fail_continue = True
    monkeypatch.setitem(sys.modules, "sentry_sdk", sentry)
    claimed: list[str] = []

    async def claim(*_args: Any, **kwargs: Any) -> SimpleNamespace:
        claimed.append(kwargs["command_id"])
        return SimpleNamespace(claimed=False, conflict=False, document={})

    monkeypatch.setattr(FlowCommandInboxService, "claim_command", claim)
    payload = _payload(sentry_trace="00-abc")
    payload.pop("trace_id")

    await FlowTask.run_flow(object(), payload, publisher=object())

    assert claimed == ["cmd-1"]
    assert metrics.calls == []
    assert sentry.continued == []
    assert sentry.tags["trace_id"] == ""
    assert get_trace_id() is None
    assert "[trace_id=N/A]" in _formatted("empty context")


@pytest.mark.asyncio
async def test_metric_failure_does_not_stop_the_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    metrics = _Metrics()
    metrics.fail = True
    sentry = _Sentry(metrics)
    monkeypatch.setitem(sys.modules, "sentry_sdk", sentry)
    claimed: list[str] = []

    async def claim(*_args: Any, **_kwargs: Any) -> SimpleNamespace:
        claimed.append("claimed")
        return SimpleNamespace(claimed=False, conflict=False, document={})

    monkeypatch.setattr(FlowCommandInboxService, "claim_command", claim)
    await FlowTask.run_flow(
        object(),
        _payload(publish_timestamp=1),
        publisher=object(),
    )
    assert claimed == ["claimed"]
    assert sentry.tags["flow_task_id"] == "task-1"


@pytest.mark.asyncio
async def test_callback_entry_clears_the_previous_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str | None] = []

    def spy(trace_id: str | None) -> None:
        seen.append(trace_id)
        set_trace_id(trace_id)

    monkeypatch.setattr("app.main.set_trace_id", spy)
    set_trace_id("stale-request")
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/callbacks/models/opencreator_ai", content=b"{}")

    assert response.status_code == 400
    assert seen[0] is None


@pytest.mark.asyncio
async def test_matched_callback_restores_flow_trace_over_a_stale_context() -> None:
    database = FakeDatabase()
    database["model_invocations"].docs.append(
        {
            "external_task_id": "ai-1",
            "invocation_id": "inv-1",
            "metadata": {},
            "run_id": "run-1",
            "status": "running",
            "vendor": "opencreator_ai",
        }
    )
    database["flow_run_state"].docs.append({"run_id": "run-1", "trace_id": "trace-run"})
    set_trace_id("stale-request")

    matched = await ModelInvocationService.handle_callback_fast(
        database,
        vendor="opencreator_ai",
        payload={"ai_task_id": "ai-1", "status": "success", "trace_id": "trace-callback"},
        idempotency_key="delivery-1",
    )

    assert matched is not None
    assert get_trace_id() == "trace-callback"

    set_trace_id("stale-request")
    await ModelInvocationService.handle_callback_fast(
        database,
        vendor="opencreator_ai",
        payload={"ai_task_id": "ai-1", "status": "success"},
        idempotency_key="delivery-1",
    )
    assert get_trace_id() == "trace-run"


def test_consumer_sentry_drops_expected_errors_and_health_transactions() -> None:
    class InsufficientCredits(Exception):
        pass

    assert (
        before_send(
            {"extra": {"prompt": "secret"}},
            {"exc_info": (InsufficientCredits, InsufficientCredits(), None)},
        )
        is None
    )
    sent = before_send(
        {
            "extra": {"prompt": "secret", "token": "t", "authorization": "a", "safe": "keep"},
            "breadcrumbs": {"values": [{"data": {"password": "p"}}]},
        },
        {},
    )
    assert sent is not None
    assert sent["extra"]["prompt"] == "[FILTERED]"
    assert sent["extra"]["token"] == "[FILTERED]"
    assert sent["extra"]["authorization"] == "[FILTERED]"
    assert sent["extra"]["safe"] == "keep"
    assert sent["breadcrumbs"]["values"][0]["data"]["password"] == "[FILTERED]"
    assert traces_sampler({"transaction_context": {"name": "/health"}}) == 0
    assert traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0
    flow_run = traces_sampler(
        {"transaction_context": {"op": "flow.run", "name": "flow:task-1"}}
    )
    assert flow_run == 0.05
    assert traces_sampler({"transaction_context": {"name": "POST /callbacks"}}) == 0.1
    assert before_send_transaction({"transaction": "/health"}, {}) is None
    assert before_send_transaction({"transaction": "flow:task-1"}, {}) == {
        "transaction": "flow:task-1"
    }


def test_empty_consumer_dsn_skips_sentry_init(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[dict[str, Any]] = []

    class Sdk:
        @staticmethod
        def init(**kwargs: Any) -> None:
            called.append(kwargs)

    monkeypatch.setitem(sys.modules, "sentry_sdk", Sdk)
    init_sentry("", "local")
    assert called == []
    init_sentry("https://dsn.example/1", "test")
    assert called[0]["traces_sampler"] is traces_sampler
    assert called[0]["profiles_sample_rate"] == 0.1
    assert called[0]["send_default_pii"] is False
