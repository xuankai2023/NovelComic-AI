from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.controller.v2.flow_runs import (
    _REDIS_CURSOR_RE,
    _claim_workflow_connection,
    _unregister_workflow_connection,
)
from app.database.mq import workflow_v2_mq_callback
from app.main import create_app
from app.services.workflow_event_store import WorkflowEventStore
from app.services.workflow_snapshot_client import WorkflowSnapshotClient


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
            if key == "$and":
                if not all(FakeCollection._matches(document, item) for item in expected):
                    return False
                continue
            exists = key in document
            actual = document.get(key)
            if isinstance(expected, dict) and any(
                str(operator).startswith("$") for operator in expected
            ):
                if "$exists" in expected and exists != bool(expected["$exists"]):
                    return False
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$lt" in expected and (actual is None or not actual < expected["$lt"]):
                    return False
                if "$lte" in expected and (actual is None or not actual <= expected["$lte"]):
                    return False
                continue
            if actual != expected:
                return False
        return True

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(deepcopy(document))

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        del projection
        for document in self.docs:
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
    ) -> SimpleNamespace:
        for document in self.docs:
            if self._matches(document, query):
                document.update(deepcopy(update.get("$set", {})))
                if "$setOnInsert" in update:
                    for key, value in update["$setOnInsert"].items():
                        document.setdefault(key, deepcopy(value))
                return SimpleNamespace(matched_count=1, modified_count=1)
        if upsert:
            document = {key: value for key, value in query.items() if not key.startswith("$")}
            document.update(deepcopy(update.get("$setOnInsert", {})))
            document.update(deepcopy(update.get("$set", {})))
            self.docs.append(document)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeRedis:
    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.dedupe: dict[str, dict[str, str]] = {}
        self.values: dict[str, str] = {}
        self.published: list[tuple[str, str]] = []
        self.ttls: dict[str, int] = {}
        self.sequence = 0

    async def eval(self, script: str, numkeys: int, *args: Any) -> list[str]:
        del script, numkeys
        (
            stream_key,
            dedupe_key,
            notification_key,
            event_id,
            event_json,
            flow_task_id,
            ttl_seconds,
            _stream_maxlen,
            notification_channel,
        ) = args
        dedupe = self.dedupe.setdefault(str(dedupe_key), {})
        if event_id in dedupe:
            return [dedupe[event_id], "0"]
        self.sequence += 1
        cursor = f"{self.sequence}-0"
        self.streams.setdefault(str(stream_key), []).append(
            (cursor, {"event_id": str(event_id), "event": str(event_json)})
        )
        dedupe[str(event_id)] = cursor
        self.streams.setdefault(str(notification_key), []).append(
            (
                f"{self.sequence}-1",
                {
                    "cursor": cursor,
                    "event_id": str(event_id),
                    "flow_task_id": str(flow_task_id),
                },
            )
        )
        ttl = int(ttl_seconds)
        self.ttls[str(stream_key)] = ttl
        self.ttls[str(dedupe_key)] = ttl
        self.ttls[str(notification_key)] = ttl
        self.published.append(
            (
                str(notification_channel),
                f"{flow_task_id}|{cursor}|{event_id}",
            )
        )
        return [cursor, "1"]

    @staticmethod
    def _cursor_key(cursor: str) -> tuple[int, int]:
        left, right = str(cursor).split("-", 1)
        return int(left), int(right)

    async def xrange(
        self,
        stream_key: str,
        min: str = "-",
        max: str = "+",
        **kwargs: Any,
    ) -> list[Any]:
        entries = list(self.streams.get(stream_key, []))
        if min.startswith("("):
            floor = self._cursor_key(min[1:])
            entries = [item for item in entries if self._cursor_key(item[0]) > floor]
        elif min != "-":
            floor = self._cursor_key(min)
            entries = [item for item in entries if self._cursor_key(item[0]) >= floor]
        if max != "+":
            ceiling = self._cursor_key(max)
            entries = [item for item in entries if self._cursor_key(item[0]) <= ceiling]
        count = kwargs.get("count")
        if count is not None:
            entries = entries[: int(count)]
        return entries

    async def xrevrange(
        self,
        stream_key: str,
        max: str = "+",
        min: str = "-",
        count: int | None = None,
    ) -> list[Any]:
        entries = await self.xrange(stream_key, min=min, max=max)
        entries.reverse()
        if count is not None:
            entries = entries[: int(count)]
        return entries

    async def xlen(self, stream_key: str) -> int:
        return len(self.streams.get(stream_key, []))

    async def hlen(self, key: str) -> int:
        return len(self.dedupe.get(key, {}))

    async def xread(
        self,
        streams: dict[str, str],
        *,
        count: int,
        block: int,
    ) -> list[Any]:
        del block
        rows: list[Any] = []
        for stream_key, cursor in streams.items():
            entries = [
                (entry_id, fields)
                for entry_id, fields in self.streams.get(stream_key, [])
                if entry_id > cursor
            ][:count]
            if entries:
                rows.append((stream_key, entries))
        return rows

    async def incr(self, key: str) -> int:
        next_value = int(self.values.get(key, "0")) + 1
        self.values[key] = str(next_value)
        return next_value

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def expire(self, key: str, ttl: int) -> bool:
        self.ttls[key] = int(ttl)
        return True


class FakeMessage:
    def __init__(
        self,
        payload: dict[str, Any] | None = None,
        *,
        headers: dict[str, Any] | None = None,
        raw_body: bytes | None = None,
    ) -> None:
        if raw_body is not None:
            self.body = raw_body
        else:
            self.body = json.dumps(payload or {}).encode()
        self.headers = headers or {}
        self.properties = SimpleNamespace(headers=self.headers)
        self.acked = False
        self.nacked = False
        self.rejected = False
        self.requeue: bool | None = None

    async def ack(self) -> None:
        self.acked = True

    async def nack(self, *, requeue: bool) -> None:
        self.nacked = True
        self.requeue = requeue

    async def reject(self, *, requeue: bool) -> None:
        self.rejected = True
        self.requeue = requeue


def _reply_event(**overrides: Any) -> dict[str, Any]:
    event = {
        "command_id": "wfc_1",
        "event_id": "evt-1",
        "event_type": "node_status",
        "flow_run_id": "run-1",
        "flow_task_id": "task-1",
        "payload": {"node_id": "n1", "status": "select"},
        "protocol_version": 2,
    }
    event.update(overrides)
    return event


async def _seed_run(database: FakeDatabase, **overrides: Any) -> None:
    document = {
        "current_wire_command_id": "wfc_1",
        "flow_task_id": "task-1",
        "protocol_version": 2,
        "status": "running",
        "user_id": "user-1",
    }
    document.update(overrides)
    await database["flow_task"].insert_one(document)


def test_redis_cursor_regex_rejects_invalid_cursor() -> None:
    assert _REDIS_CURSOR_RE.match("1-0")
    assert not _REDIS_CURSOR_RE.match("not-a-cursor")


@pytest.mark.asyncio
async def test_event_store_appends_once_and_replays_after_cursor() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    event = {
        "event_id": "evt-1",
        "event_type": "node_status",
        "flow_task_id": "task-1",
        "payload": {"node_id": "n1", "status": "running"},
        "protocol_version": 2,
    }

    first = await WorkflowEventStore.append_event(
        database, "task-1", redis_client=redis, event=event
    )
    second = await WorkflowEventStore.append_event(
        database, "task-1", redis_client=redis, event=event
    )
    replay = await WorkflowEventStore.replay_after(database, "task-1", None, redis_client=redis)
    replay_after_first = await WorkflowEventStore.replay_after(
        database, "task-1", first["cursor"], redis_client=redis
    )

    assert first["inserted"] is True
    assert second["inserted"] is False
    assert first["cursor"] == second["cursor"]
    assert len(replay) == 1
    assert replay[0]["event_id"] == "evt-1"
    assert replay_after_first == []
    assert len(redis.published) == 1
    assert redis.dedupe[WorkflowEventStore._dedupe_key("task-1")]["evt-1"] == first["cursor"]


def test_append_event_script_checks_event_id_before_publish() -> None:
    script = WorkflowEventStore._APPEND_EVENT_SCRIPT
    positions = [
        script.index("HGET"),
        script.index("XADD"),
        script.index("HSET"),
        script.index("EXPIRE"),
        script.index("PUBLISH"),
    ]
    assert positions == sorted(positions)
    assert "return {existing, '0'}" in script
    assert "return {cursor, '1'}" in script


@pytest.mark.asyncio
async def test_event_store_connection_generation_replaces_previous_socket() -> None:
    redis = FakeRedis()

    first = await WorkflowEventStore.claim_connection_generation(redis, "task-1", "conn-1")
    second = await WorkflowEventStore.claim_connection_generation(redis, "task-1", "conn-1")

    assert first == 1
    assert second == 2
    assert not await WorkflowEventStore.is_current_generation(redis, "task-1", "conn-1", first)
    assert await WorkflowEventStore.is_current_generation(redis, "task-1", "conn-1", second)


@pytest.mark.asyncio
async def test_mq_callback_appends_event_updates_status_then_acks() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_run(database)
    await database["workflow_command"].insert_one(
        {
            "command_id": "cmd-user",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "wire_command_id": "wfc_1",
        }
    )
    message = FakeMessage(_reply_event(event_id="evt-select"))

    await workflow_v2_mq_callback(message, database=database, redis_client=redis)

    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    replay = await WorkflowEventStore.replay_after(database, "task-1", None, redis_client=redis)
    assert message.acked is True
    assert message.nacked is False
    assert message.rejected is False
    assert run["status"] == "waiting_for_selection"
    assert run["last_event_cursor"] == "1-0"
    assert run["last_event_cursor_ms"] == 1
    assert run["last_event_cursor_sequence"] == 0
    assert run["last_event_id"] == "evt-select"
    assert replay[0]["client_command_id"] == "cmd-user"


@pytest.mark.asyncio
async def test_mq_callback_acks_duplicate_event_without_second_stream_entry() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_run(database)
    payload = _reply_event(event_id="evt-select")
    first = FakeMessage(payload)
    second = FakeMessage(payload)

    await workflow_v2_mq_callback(first, database=database, redis_client=redis)
    await workflow_v2_mq_callback(second, database=database, redis_client=redis)

    replay = await WorkflowEventStore.replay_after(database, "task-1", None, redis_client=redis)
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert first.acked is True
    assert second.acked is True
    assert second.nacked is False
    assert [event["event_id"] for event in replay] == ["evt-select"]
    assert run["last_event_cursor"] == "1-0"


@pytest.mark.asyncio
async def test_mq_callback_nacks_when_append_fails_before_ack() -> None:
    database = FakeDatabase()
    await _seed_run(database)
    message = FakeMessage(
        _reply_event(event_id="evt-fail", event_type="finish_flow", payload={"status": "completed"})
    )

    with patch.object(
        WorkflowEventStore,
        "append_event",
        new=AsyncMock(side_effect=RuntimeError("redis down")),
    ):
        await workflow_v2_mq_callback(message, database=database, redis_client=FakeRedis())

    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert message.acked is False
    assert message.nacked is True
    assert message.requeue is True
    assert message.rejected is False
    assert "last_event_cursor" not in run


@pytest.mark.asyncio
async def test_mq_callback_rejects_malformed_result_without_appending() -> None:
    database = FakeDatabase()
    await _seed_run(database)
    redis = FakeRedis()
    cases = [
        FakeMessage(raw_body=b"not-json"),
        FakeMessage(_reply_event(protocol_version=1)),
        FakeMessage({key: value for key, value in _reply_event().items() if key != "command_id"}),
        FakeMessage(
            _reply_event(),
            headers={"command_id": "wfc_other", "protocol_version": 2},
        ),
        FakeMessage(
            _reply_event(),
            headers={"flow_task_id": "task-other"},
        ),
    ]

    for message in cases:
        with patch.object(
            WorkflowEventStore,
            "append_event",
            new=AsyncMock(side_effect=AssertionError("malformed result must not be appended")),
        ):
            await workflow_v2_mq_callback(message, database=database, redis_client=redis)
        assert message.acked is False
        assert message.nacked is False
        assert message.rejected is True
        assert message.requeue is False

    assert redis.streams == {}


@pytest.mark.asyncio
async def test_mq_callback_does_not_roll_back_terminal_status_or_cursor() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_run(database, status="completed")
    newer = FakeMessage(_reply_event(event_id="evt-late", event_type="start_flow", payload={}))
    await workflow_v2_mq_callback(newer, database=database, redis_client=redis)
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert newer.acked is True
    assert run["status"] == "completed"
    assert run["last_event_cursor"] == "1-0"

    stored = database["flow_task"].docs[0]
    stored["last_event_cursor"] = "50-0"
    stored["last_event_cursor_ms"] = 50
    stored["last_event_cursor_sequence"] = 0
    older = FakeMessage(
        _reply_event(
            event_id="evt-old",
            event_type="finish_flow",
            payload={"status": "failed"},
        )
    )
    await workflow_v2_mq_callback(older, database=database, redis_client=redis)
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    replay = await WorkflowEventStore.replay_after(database, "task-1", None, redis_client=redis)
    assert older.acked is True
    assert run["status"] == "completed"
    assert run["last_event_cursor"] == "50-0"
    assert [event["event_id"] for event in replay] == ["evt-late", "evt-old"]


@pytest.mark.asyncio
async def test_mq_callback_keeps_cancel_requested_until_terminal_event() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_run(database, status="cancel_requested")
    select_message = FakeMessage(_reply_event(event_id="evt-select"))
    await workflow_v2_mq_callback(select_message, database=database, redis_client=redis)
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert select_message.acked is True
    assert run["status"] == "cancel_requested"

    killed = FakeMessage(_reply_event(event_id="evt-killed", event_type="flow_killed", payload={}))
    await workflow_v2_mq_callback(killed, database=database, redis_client=redis)
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert killed.acked is True
    assert run["status"] == "killed"
    assert run["dispatch_state"] == "cancelled"


@pytest.mark.asyncio
async def test_mq_callback_ignores_status_from_previous_command() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_run(
        database,
        current_wire_command_id="wfc_new",
        status="waiting_for_selection",
    )
    message = FakeMessage(
        _reply_event(command_id="wfc_old", event_id="evt-old-command", event_type="start_flow")
    )

    await workflow_v2_mq_callback(message, database=database, redis_client=redis)

    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert message.acked is True
    assert run["status"] == "waiting_for_selection"
    assert run["last_event_cursor"] == "1-0"


def test_websocket_invalid_cursor_returns_resume_error(monkeypatch: pytest.MonkeyPatch) -> None:
    database = FakeDatabase()
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-1",
            "flow_run_id": "run-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )
    app = create_app()
    app.state.connections = SimpleNamespace(
        mongo={"novelcomic": database},
        redis=FakeRedis(),
    )

    with patch("app.controller.v2.flow_runs.get_settings") as get_settings:
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        with patch.object(
            WorkflowEventStore,
            "replay_after",
            new=AsyncMock(return_value=[]),
        ):
            with patch(
                "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
                new=AsyncMock(return_value="user-1"),
            ):
                client = TestClient(app)
                with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
                    ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
                    assert ws.receive_json()["event_type"] == "authenticated"
                    ws.send_json(
                        {
                            "event_type": "attach_flow",
                            "last_event_cursor": "not-a-cursor",
                            "protocol_version": 2,
                        }
                    )
                    assert ws.receive_json()["event_type"] == "resume_error"


def test_websocket_expired_cursor_returns_resume_error_and_4409() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-1",
            "flow_run_id": "run-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )
    redis.streams[WorkflowEventStore._stream_key("task-1")] = [
        (
            "5-0",
            {
                "event": json.dumps(
                    {
                        "event_id": "evt-5",
                        "event_type": "node_status",
                        "flow_task_id": "task-1",
                        "payload": {"node_id": "n1", "status": "running"},
                        "protocol_version": 2,
                    }
                )
            },
        )
    ]
    app = create_app()
    app.state.connections = SimpleNamespace(
        mongo={"novelcomic": database},
        redis=redis,
    )

    with patch("app.controller.v2.flow_runs.get_settings") as get_settings:
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        with patch(
            "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
            new=AsyncMock(return_value="user-1"),
        ):
            client = TestClient(app)
            with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
                ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
                assert ws.receive_json()["event_type"] == "authenticated"
                ws.send_json(
                    {
                        "event_type": "attach_flow",
                        "last_event_cursor": "1-0",
                        "protocol_version": 2,
                    }
                )
                resume_error = ws.receive_json()
                assert resume_error["event_type"] == "resume_error"
                assert resume_error["code"] == "RESUME_WINDOW_EXPIRED"
                assert resume_error["reason"] == "cursor_expired"
                with pytest.raises(WebSocketDisconnect) as exc_info:
                    ws.receive_json()
                assert exc_info.value.code == 4409


def test_websocket_replays_events_before_resume_ready() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-1",
            "flow_run_id": "run-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )

    app = create_app()
    app.state.connections = SimpleNamespace(
        mongo={"novelcomic": database},
        redis=redis,
    )

    async def _append_event() -> None:
        await WorkflowEventStore.append_event(
            database,
            "task-1",
            redis_client=redis,
            event={
                "event_id": "evt-1",
                "event_type": "node_status",
                "flow_task_id": "task-1",
                "payload": {"node_id": "n1", "status": "running"},
                "protocol_version": 2,
            },
        )

    import anyio

    anyio.run(_append_event)

    with patch("app.controller.v2.flow_runs.get_settings") as get_settings:
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        with patch(
            "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
            new=AsyncMock(return_value="user-1"),
        ):
            client = TestClient(app)
            with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
                ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
                assert ws.receive_json()["event_type"] == "authenticated"
                ws.send_json(
                    {
                        "event_type": "attach_flow",
                        "last_event_cursor": None,
                        "protocol_version": 2,
                    }
                )
                replayed = ws.receive_json()
                assert replayed["event_type"] == "workflow_event"
                assert replayed["event"]["event_id"] == "evt-1"
                assert replayed["replayed"] is True

                ready = ws.receive_json()
                assert ready["event_type"] == "resume_ready"
                assert ready["cursor"] == "1-0"
                assert ready["event_cursor"] == "1-0"
                assert ready["latest_event_cursor"] == "1-0"
                assert ready["connection_id"] == "conn-1"
                assert ready["status"] == "running"


def _events_app(database: FakeDatabase, redis: FakeRedis) -> TestClient:
    app = create_app()
    app.state.connections = SimpleNamespace(
        mongo={"novelcomic": database},
        redis=redis,
    )
    return TestClient(app)


def _patch_ws_dependencies():
    settings = patch("app.controller.v2.flow_runs.get_settings")
    jwt = patch(
        "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
        new=AsyncMock(return_value="user-1"),
    )
    return settings, jwt


def test_available_cursor_does_not_fetch_a_snapshot() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(
        {
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )

    async def _append_event() -> None:
        await WorkflowEventStore.append_event(
            database,
            "task-1",
            redis_client=redis,
            event={
                "event_id": "evt-1",
                "event_type": "node_status",
                "flow_task_id": "task-1",
                "payload": {"node_id": "n1", "status": "running"},
                "protocol_version": 2,
            },
        )

    import anyio

    anyio.run(_append_event)
    fetch = AsyncMock(side_effect=AssertionError("snapshot should not be fetched"))

    settings, jwt = _patch_ws_dependencies()
    with settings as get_settings, jwt, patch.object(WorkflowSnapshotClient, "fetch", fetch):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, redis)
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
            ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            assert ws.receive_json()["event_type"] == "authenticated"
            ws.send_json(
                {
                    "event_cursor": "0-0",
                    "event_type": "attach_flow",
                    "protocol_version": 2,
                }
            )
            assert ws.receive_json()["event_type"] == "workflow_event"
            ready = ws.receive_json()
            assert ready["event_type"] == "resume_ready"
    fetch.assert_not_called()


def test_expired_cursor_sends_snapshot_before_resume_ready() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(
        {
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )
    redis.streams[WorkflowEventStore._stream_key("task-1")] = [
        (
            "5-0",
            {
                "event": json.dumps(
                    {
                        "event_id": "evt-5",
                        "event_type": "node_status",
                        "flow_task_id": "task-1",
                        "payload": {},
                        "protocol_version": 2,
                    }
                )
            },
        )
    ]
    snapshot = {
        "flow_node_state": [{"node_id": "n1", "status": "running"}],
        "flow_run_id": "run-1",
        "flow_task_id": "task-1",
        "protocol_version": 2,
        "status": "completed",
    }
    fetch = AsyncMock(return_value=snapshot)

    settings, jwt = _patch_ws_dependencies()
    with settings as get_settings, jwt, patch.object(WorkflowSnapshotClient, "fetch", fetch):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, redis)
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
            ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            assert ws.receive_json()["event_type"] == "authenticated"
            ws.send_json(
                {
                    "event_type": "attach_flow",
                    "last_event_cursor": "1-0",
                    "protocol_version": 2,
                }
            )
            flow_snapshot = ws.receive_json()
            ready = ws.receive_json()

    fetch.assert_awaited_once_with("task-1")
    assert flow_snapshot["event_type"] == "flow_snapshot"
    assert flow_snapshot["event_id"].startswith("snapshot-")
    assert len(flow_snapshot["event_id"]) == len("snapshot-") + 24
    assert flow_snapshot["event_cursor"] == "5-0"
    assert flow_snapshot["replayed"] is True
    assert flow_snapshot["status"] == "running"
    assert flow_snapshot["snapshot"]["status"] == "completed"
    assert ready["event_type"] == "resume_ready"
    assert ready["status"] == "running"
    assert ready["event_cursor"] == "5-0"
    assert ready["latest_event_cursor"] == "5-0"
    assert ready["connection_id"] == "conn-1"


def test_resume_ready_uses_status_written_during_replay() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(
        {
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "running",
            "trace_id": "trace-1",
            "user_id": "user-1",
        }
    )

    async def _append_event() -> None:
        await WorkflowEventStore.append_event(
            database,
            "task-1",
            redis_client=redis,
            event={
                "event_id": "evt-1",
                "event_type": "node_status",
                "flow_task_id": "task-1",
                "payload": {"node_id": "n1", "status": "running"},
                "protocol_version": 2,
            },
        )

    import anyio

    anyio.run(_append_event)
    original = WorkflowEventStore.replay_after
    finished = False

    async def _finish_during_replay(
        database: FakeDatabase,
        flow_task_id: str,
        cursor: str | None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        nonlocal finished
        events = await original(database, flow_task_id, cursor, **kwargs)
        if not finished:
            finished = True
            await database["flow_task"].update_one(
                {"flow_task_id": flow_task_id},
                {"$set": {"status": "completed"}},
            )
            await WorkflowEventStore.append_event(
                database,
                flow_task_id,
                redis_client=redis,
                event={
                    "event_id": "evt-finish",
                    "event_type": "finish_flow",
                    "flow_task_id": flow_task_id,
                    "payload": {"status": "completed"},
                    "protocol_version": 2,
                },
            )
        return events

    settings, jwt = _patch_ws_dependencies()
    with (
        settings as get_settings,
        jwt,
        patch.object(WorkflowEventStore, "replay_after", _finish_during_replay),
    ):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, redis)
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as ws:
            ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            assert ws.receive_json()["event_type"] == "authenticated"
            ws.send_json(
                {
                    "event_type": "attach_flow",
                    "last_event_cursor": "0-0",
                    "protocol_version": 2,
                }
            )
            first = ws.receive_json()
            finish = ws.receive_json()
            ready = ws.receive_json()

    assert first["event"]["event_id"] == "evt-1"
    assert finish["event"]["event_id"] == "evt-finish"
    assert ready["event_type"] == "resume_ready"
    assert ready["status"] == "completed"
    assert ready["event_cursor"] == "2-0"
    assert ready["latest_event_cursor"] == "2-0"


@pytest.mark.asyncio
async def test_same_connection_id_closes_the_previous_socket() -> None:
    class _Socket:
        def __init__(self) -> None:
            self.codes: list[int] = []

        async def close(self, code: int) -> None:
            self.codes.append(code)

    first = _Socket()
    second = _Socket()
    await _claim_workflow_connection("task-claim", "conn-claim", first)  # type: ignore[arg-type]
    await _claim_workflow_connection("task-claim", "conn-claim", second)  # type: ignore[arg-type]
    assert first.codes == [4001]
    await _unregister_workflow_connection("task-claim", "conn-claim", second)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_zero_cursor_is_available_until_the_stream_no_longer_starts_at_zero() -> None:
    intact = FakeRedis()
    await WorkflowEventStore.append_event(
        FakeDatabase(),
        "task-intact",
        redis_client=intact,
        event={
            "event_id": "evt-1",
            "event_type": "node_status",
            "flow_task_id": "task-intact",
            "payload": {},
            "protocol_version": 2,
        },
    )
    assert await WorkflowEventStore.is_cursor_available(
        "task-intact",
        "0-0",
        redis_client=intact,
    )
    assert await WorkflowEventStore.latest_cursor("task-intact", redis_client=intact) == "1-0"

    trimmed = FakeRedis()
    trimmed.streams[WorkflowEventStore._stream_key("task-trimmed")] = [("5-0", {"event": "{}"})]
    trimmed.dedupe[WorkflowEventStore._dedupe_key("task-trimmed")] = {
        "evt-old": "1-0",
        "evt-new": "5-0",
    }
    assert not await WorkflowEventStore.is_cursor_available(
        "task-trimmed",
        "0-0",
        redis_client=trimmed,
    )

    expired = FakeDatabase()
    await expired["flow_task"].insert_one(
        {
            "flow_task_id": "task-expired",
            "last_event_cursor": "9-0",
            "protocol_version": 2,
        }
    )
    assert not await WorkflowEventStore.is_cursor_available(
        "task-expired",
        "0-0",
        redis_client=FakeRedis(),
        database=expired,
    )
    assert await WorkflowEventStore.latest_cursor("task-empty", redis_client=FakeRedis()) == "0-0"


def _owned_run(user_id: str, flow_task_id: str = "task-1") -> dict[str, Any]:
    return {
        "flow_run_id": "run-1",
        "flow_task_id": flow_task_id,
        "protocol_version": 2,
        "status": "running",
        "trace_id": "trace-1",
        "user_id": user_id,
    }


def test_websocket_does_not_replay_before_auth() -> None:
    database = FakeDatabase()
    replay = AsyncMock(side_effect=AssertionError("replayed before auth"))
    with patch("app.controller.v2.flow_runs.get_settings") as get_settings, patch.object(
        WorkflowEventStore,
        "replay_after",
        replay,
    ):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, FakeRedis())
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as websocket:
            websocket.send_json({"event_type": "ping", "protocol_version": 2})
            message = websocket.receive_json()
            assert message["code"] == "AUTH_REQUIRED"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_json()
    assert caught.value.code == 4401
    replay.assert_not_called()


def test_websocket_other_users_run_is_4404_before_replay() -> None:
    database = FakeDatabase()
    database["flow_task"].docs.append(_owned_run("user-b", "task-b"))
    replay = AsyncMock(side_effect=AssertionError("replayed another user's run"))
    with (
        patch("app.controller.v2.flow_runs.get_settings") as get_settings,
        patch.object(WorkflowEventStore, "replay_after", replay),
        patch(
            "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
            new=AsyncMock(return_value="user-a"),
        ),
    ):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, FakeRedis())
        with client.websocket_connect("/api/v2/flow/runs/task-b/events/conn-1") as websocket:
            websocket.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            message = websocket.receive_json()
            assert message["code"] == "RUN_NOT_FOUND"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_json()
    assert caught.value.code == 4404
    replay.assert_not_called()


def test_websocket_message_after_auth_must_be_attach_flow() -> None:
    database = FakeDatabase()
    database["flow_task"].docs.append(_owned_run("user-a"))
    with (
        patch("app.controller.v2.flow_runs.get_settings") as get_settings,
        patch(
            "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
            new=AsyncMock(return_value="user-a"),
        ),
    ):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, FakeRedis())
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as websocket:
            websocket.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            assert websocket.receive_json()["event_type"] == "authenticated"
            websocket.send_json({"event_type": "ping", "protocol_version": 2})
            message = websocket.receive_json()
            assert message["code"] == "ATTACH_REQUIRED"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_json()
    assert caught.value.code == 4400


def test_websocket_replies_pong_to_ping_after_resume_ready() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    database["flow_task"].docs.append(_owned_run("user-a"))
    with (
        patch("app.controller.v2.flow_runs.get_settings") as get_settings,
        patch(
            "app.controller.v2.flow_runs.JwtService.get_user_id_with_backoff",
            new=AsyncMock(return_value="user-a"),
        ),
    ):
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")
        client = _events_app(database, redis)
        with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as websocket:
            websocket.send_json({"event_type": "auth", "protocol_version": 2, "token": "jwt"})
            assert websocket.receive_json()["event_type"] == "authenticated"
            websocket.send_json(
                {
                    "event_type": "attach_flow",
                    "last_event_cursor": "0-0",
                    "protocol_version": 2,
                }
            )
            assert websocket.receive_json()["event_type"] == "resume_ready"
            websocket.send_json({"event_type": "ping", "protocol_version": 2})
            pong = websocket.receive_json()
            assert pong["event_type"] == "pong"
            assert pong["protocol_version"] == 2

