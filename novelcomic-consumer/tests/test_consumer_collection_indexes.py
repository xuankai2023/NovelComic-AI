"""Consumer 集合代理、fail-fast 索引，以及启动时的退出。"""

from __future__ import annotations

import asyncio
import logging
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest

from app.config import get_settings
from app.database.mongo import (
    B2B_SIGNAL_ACTIONS,
    B2B_SIGNAL_EVENTS,
    B2B_SIGNAL_NOTIFICATIONS,
    CREDITS_INOUT_RECORD,
    FLOW_COMMAND_INBOX,
    FLOW_EVENT_OUTBOX,
    FLOW_RUN_STATE,
    NODE_RESULTS,
    PENDING_MODEL_CALLBACK,
    REQUIRED_V2_INDEXES,
    init_consumer_v1_indexes,
    test_mongo,
)
from app.main import lifespan
from app.tasks.flow import FlowStreamWorker


def _path(document: dict[str, Any], field: str) -> Any:
    current: Any = document
    present = True
    for part in field.split("."):
        if not isinstance(current, dict) or part not in current:
            present = False
            return None, present
        current = current[part]
    return current, present


def _partial_matches(document: dict[str, Any], expression: dict[str, Any] | None) -> bool:
    if not expression:
        return True
    for field, expected in expression.items():
        actual, present = _path(document, field)
        if isinstance(expected, dict) and set(expected) == {"$type"}:
            if expected["$type"] == "string" and not isinstance(actual, str):
                return False
            continue
        if isinstance(expected, dict) and set(expected) == {"$exists"}:
            if bool(expected["$exists"]) != present:
                return False
            continue
        if actual != expected:
            return False
    return True


def _normalize_keys(keys: Any) -> list[tuple[str, int]]:
    if isinstance(keys, str):
        return [(keys, 1)]
    return [(field, direction) for field, direction in keys]


class RecordingCollection:
    def __init__(self, database: RecordingDatabase, name: str) -> None:
        self.database = database
        self.name = name
        self.docs: list[dict[str, Any]] = []
        self.indexes: list[dict[str, Any]] = []

    async def create_index(self, keys: Any, **kwargs: Any) -> str:
        if self.database.fail_names and kwargs.get("name") in self.database.fail_names:
            raise RuntimeError(f"index failed: {kwargs.get('name')}")
        if self.database.fail_unnamed and not kwargs.get("name"):
            normalized = _normalize_keys(keys)
            if normalized == self.database.fail_unnamed:
                raise RuntimeError(f"index failed: {self.name} {normalized}")
        spec = {
            "keys": _normalize_keys(keys),
            "name": kwargs.get("name"),
            "unique": bool(kwargs.get("unique")),
            "partial": kwargs.get("partialFilterExpression"),
            "expire": kwargs.get("expireAfterSeconds"),
        }
        existing = next((item for item in self.indexes if item == spec), None)
        if existing is None:
            same_name = next(
                (item for item in self.indexes if item["name"] and item["name"] == spec["name"]),
                None,
            )
            if same_name is not None and same_name != spec:
                raise RuntimeError(f"index spec changed: {spec['name']}")
            self.indexes.append(spec)
        self.database.operations.append(("create_index", self.name, spec["name"], spec["keys"]))
        return str(spec["name"])

    def _conflicts(self, document: dict[str, Any]) -> bool:
        for index in self.indexes:
            if not index["unique"] or not _partial_matches(document, index["partial"]):
                continue
            key = tuple(_path(document, field)[0] for field, _direction in index["keys"])
            for existing in self.docs:
                if not _partial_matches(existing, index["partial"]):
                    continue
                existing_key = tuple(
                    _path(existing, field)[0] for field, _direction in index["keys"]
                )
                if existing_key == key:
                    return True
        return False

    async def insert_one(self, document: dict[str, Any]) -> None:
        stored = deepcopy(document)
        if self._conflicts(stored):
            raise RuntimeError("duplicate key")
        self.docs.append(stored)


class RecordingDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, RecordingCollection] = {}
        self.operations: list[tuple[Any, ...]] = []
        self.fail_ping = False
        self.fail_names: set[str] = set()
        self.fail_unnamed: list[tuple[str, int]] | None = None

    def __getitem__(self, name: str) -> RecordingCollection:
        if name not in self.collections:
            self.collections[name] = RecordingCollection(self, name)
        return self.collections[name]

    async def list_collection_names(self) -> list[str]:
        if self.fail_ping:
            raise ConnectionError("mongodb down")
        return list(self.collections)


def _index(database: RecordingDatabase, collection: str, name: str) -> dict[str, Any]:
    return next(item for item in database[collection].indexes if item["name"] == name)


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> RecordingDatabase:
    recording = RecordingDatabase()
    monkeypatch.setattr("app.database.mongo.get_db", lambda: recording)
    return recording


@pytest.mark.asyncio
async def test_consumer_indexes_are_idempotent_and_reject_duplicate_commands(
    database: RecordingDatabase,
) -> None:
    await init_consumer_v1_indexes()
    first_count = len(database.operations)
    await init_consumer_v1_indexes()
    assert len(database.operations) == first_count * 2

    command_unique = _index(database, FLOW_COMMAND_INBOX, "flow_command_inbox_command_id_unique")
    assert command_unique["unique"] is True
    assert command_unique["keys"] == [("command_id", 1)]
    inbox_ttl = _index(database, FLOW_COMMAND_INBOX, "flow_command_inbox_terminal_ttl")
    assert inbox_ttl["expire"] == 0
    event_unique = _index(database, FLOW_EVENT_OUTBOX, "flow_event_outbox_event_id_unique")
    assert event_unique["unique"] is True
    event_ttl = _index(database, FLOW_EVENT_OUTBOX, "flow_event_outbox_sent_ttl")
    assert event_ttl["expire"] == 0

    pending = next(
        item
        for item in database[PENDING_MODEL_CALLBACK].indexes
        if item["keys"] == [("vendor", 1), ("external_task_id", 1)]
    )
    assert pending["unique"] is False

    credits = _index(database, CREDITS_INOUT_RECORD, "credits_inout_idempotency_unique")
    assert credits["unique"] is True
    assert credits["partial"] == {"idempotency_key": {"$type": "string"}}
    direction = _index(database, CREDITS_INOUT_RECORD, "credits_inout_user_direction_created")
    assert direction["keys"] == [
        ("user_id", 1),
        ("direction", 1),
        ("created_at", -1),
    ]
    assert _index(database, CREDITS_INOUT_RECORD, "credits_inout_event_created")["keys"] == [
        ("event_type", 1),
        ("created_at", -1),
    ]
    events = _index(database, B2B_SIGNAL_EVENTS, "b2b_signal_events_event_id_unique")
    assert events["unique"] is True
    signal = _index(
        database,
        B2B_SIGNAL_NOTIFICATIONS,
        "b2b_signal_notifications_user_signal_unique",
    )
    assert signal["unique"] is True
    assert signal["keys"] == [("user_id", 1), ("composite_signal_key", 1)]
    assert database[B2B_SIGNAL_ACTIONS].indexes

    results = next(item for item in database[NODE_RESULTS].indexes if item["unique"])
    assert results["keys"] == [("run_id", 1), ("result_id", 1)]

    inbox = database[FLOW_COMMAND_INBOX]
    await inbox.insert_one({"command_id": "cmd-1"})
    with pytest.raises(RuntimeError, match="duplicate key"):
        await inbox.insert_one({"command_id": "cmd-1", "user_id": "other"})

    callbacks = database[PENDING_MODEL_CALLBACK]
    await callbacks.insert_one({"vendor": "byteplus", "external_task_id": "ext-1"})
    await callbacks.insert_one({"vendor": "byteplus", "external_task_id": "ext-1"})
    assert len(callbacks.docs) == 2


@pytest.mark.asyncio
async def test_required_index_failure_exits_and_other_index_failure_warns(
    database: RecordingDatabase,
    caplog: pytest.LogCaptureFixture,
) -> None:
    assert REQUIRED_V2_INDEXES == {
        "flow_event_outbox_event_id_unique",
        "flow_event_outbox_sent_ttl",
        "flow_command_inbox_command_id_unique",
        "flow_command_inbox_terminal_ttl",
    }

    database.fail_unnamed = [("run_id", 1)]
    with caplog.at_level(logging.INFO):
        await test_mongo()
    warnings = [record.message for record in caplog.records]
    assert any("consumer v1 index init skipped/failed" in message for message in warnings)
    assert any(record.message == "mongodb connection ok" for record in caplog.records)

    database.fail_unnamed = None
    database.fail_names.add("flow_command_inbox_command_id_unique")
    caplog.clear()
    with caplog.at_level(logging.ERROR), pytest.raises(SystemExit) as exited:
        await test_mongo()
    assert exited.value.code == 1
    assert any(
        "required workflow v2 index init failed" in record.message
        and "flow_command_inbox_command_id_unique" in record.message
        for record in caplog.records
    )
    assert not any(record.message == "mongodb connection ok" for record in caplog.records)


@pytest.mark.asyncio
async def test_mongo_exits_when_listing_collections_fails(
    database: RecordingDatabase,
) -> None:
    database.fail_ping = True
    with pytest.raises(SystemExit) as exited:
        await test_mongo()
    assert exited.value.code == 1
    assert database.operations == []


@pytest.mark.asyncio
async def test_run_state_proxy_uses_publisher_collection_name(
    database: RecordingDatabase,
) -> None:
    await init_consumer_v1_indexes()
    assert FLOW_RUN_STATE in database.collections
    assert "flow_run_states" not in database.collections
    run_unique = next(item for item in database[FLOW_RUN_STATE].indexes if item["unique"])
    assert run_unique["keys"] == [("run_id", 1)]
    assert run_unique["name"] not in REQUIRED_V2_INDEXES


@pytest.mark.asyncio
async def test_lifespan_builds_indexes_before_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    database_name = get_settings().mongo_database

    class _Connections:
        def __init__(self) -> None:
            self.mongo = {database_name: {"ready": True}}
            self.redis = None

        async def close(self) -> None:
            order.append("close")

    async def connect(_settings: Any) -> _Connections:
        order.append("connect")
        return _Connections()

    async def check_mongo() -> None:
        order.append("indexes")

    async def run(self: FlowStreamWorker) -> None:
        order.append("worker")
        await self._stop_event.wait()

    class _IdleMaintenance:
        def stop(self) -> None:
            return None

        async def wait_stopped(self) -> None:
            return None

    monkeypatch.setattr("app.main.Connections.connect", connect)
    monkeypatch.setattr("app.main.test_mongo", check_mongo)
    monkeypatch.setattr("app.main.FlowStreamWorker.run", run)
    monkeypatch.setattr(
        "app.main.register_maintenance_tasks",
        lambda *_args, **_kwargs: _IdleMaintenance(),
    )

    app = SimpleNamespace(state=SimpleNamespace())
    async with lifespan(app):  # type: ignore[arg-type]
        await asyncio.sleep(0)
        assert order == ["connect", "indexes", "worker"]
    assert order[-1] == "close"


@pytest.mark.asyncio
async def test_lifespan_closes_when_required_index_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    database_name = get_settings().mongo_database

    class _Connections:
        def __init__(self) -> None:
            self.mongo = {database_name: object()}
            self.redis = None

        async def close(self) -> None:
            order.append("close")

    async def connect(_settings: Any) -> _Connections:
        order.append("connect")
        return _Connections()

    async def check_mongo() -> None:
        order.append("indexes")
        raise SystemExit(1)

    async def run(self: FlowStreamWorker) -> None:
        order.append("worker")

    monkeypatch.setattr("app.main.Connections.connect", connect)
    monkeypatch.setattr("app.main.test_mongo", check_mongo)
    monkeypatch.setattr("app.main.FlowStreamWorker.run", run)

    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(SystemExit):
        async with lifespan(app):  # type: ignore[arg-type]
            pass
    assert order == ["connect", "indexes", "close"]
