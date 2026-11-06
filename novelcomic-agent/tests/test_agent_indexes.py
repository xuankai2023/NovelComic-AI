"""Agent 启动索引：自己的唯一键，以及共享集合上的 85/86。"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

import pytest
from pymongo.errors import DuplicateKeyError, OperationFailure

from novelcomic_agent.config import Settings
from novelcomic_agent.database.mongo import (
    AGENT_CHAT_MESSAGES,
    AGENT_EVENTS,
    AGENT_MESSAGE_FEEDBACK,
    AGENT_SESSIONS,
    AGENT_TOOL_TRACES,
    CUT_PROJECT,
    FLOW_DETAILS,
    FLOW_TASK,
    FLOW_VERSION,
    MEMORIES,
    RESULTS,
    TOOL_TRACE_TTL_SECONDS,
    ensure_indexes,
)
from novelcomic_agent.dependencies import DependencyManager


def _path(document: dict[str, Any], field: str) -> Any:
    current: Any = document
    for part in field.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


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
        failure = self.database.failures.get(self.name)
        if failure is not None and kwargs.get("name") == failure[0]:
            raise failure[1]
        spec = {
            "keys": _normalize_keys(keys),
            "name": kwargs.get("name"),
            "unique": bool(kwargs.get("unique")),
            "expire": kwargs.get("expireAfterSeconds"),
        }
        existing = next((item for item in self.indexes if item == spec), None)
        if existing is None:
            self.indexes.append(spec)
        self.database.operations.append(self.name)
        return str(spec["name"])

    def _conflicts(self, document: dict[str, Any]) -> bool:
        for index in self.indexes:
            if not index["unique"]:
                continue
            key = tuple(_path(document, field) for field, _direction in index["keys"])
            for existing in self.docs:
                existing_key = tuple(
                    _path(existing, field) for field, _direction in index["keys"]
                )
                if existing_key == key:
                    return True
        return False

    async def insert_one(self, document: dict[str, Any]) -> None:
        stored = deepcopy(document)
        if self._conflicts(stored):
            raise DuplicateKeyError("duplicate key")
        self.docs.append(stored)


class RecordingDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, RecordingCollection] = {}
        self.operations: list[str] = []
        self.failures: dict[str, tuple[str, OperationFailure]] = {}

    def __getitem__(self, name: str) -> RecordingCollection:
        collection = self.collections.get(name)
        if collection is None:
            collection = RecordingCollection(self, name)
            self.collections[name] = collection
        return collection


def _index(database: RecordingDatabase, collection: str, name: str) -> dict[str, Any]:
    found = next(item for item in database[collection].indexes if item["name"] == name)
    return found


@pytest.mark.asyncio
async def test_own_indexes_come_before_shared_indexes() -> None:
    database = RecordingDatabase()
    await ensure_indexes(database)
    await ensure_indexes(database)

    first_shared = database.operations.index(FLOW_DETAILS)
    assert database.operations.index(AGENT_SESSIONS) < first_shared
    assert database.operations.index(MEMORIES) < first_shared
    assert FLOW_TASK in database.operations
    assert FLOW_VERSION in database.operations
    assert RESULTS in database.operations
    assert CUT_PROJECT in database.operations
    assert "flow_details" not in database.collections
    assert "results" not in database.collections
    assert database[FLOW_DETAILS].name == "flow_projects"
    assert database[RESULTS].name == "node_results"


@pytest.mark.asyncio
async def test_agent_event_id_unique_and_tool_trace_ttl() -> None:
    database = RecordingDatabase()
    await ensure_indexes(database)

    assert _index(database, AGENT_CHAT_MESSAGES, "session_message_unique_idx")["unique"] is True
    assert _index(database, AGENT_EVENTS, "session_event_unique_idx") == {
        "keys": [("session_id", 1), ("event_id", 1)],
        "name": "session_event_unique_idx",
        "unique": True,
        "expire": None,
    }
    assert _index(database, AGENT_MESSAGE_FEEDBACK, "session_turn_user_unique_idx")["keys"] == [
        ("session_id", 1),
        ("turn", 1),
        ("user_id", 1),
    ]
    ttl = _index(database, AGENT_TOOL_TRACES, "ttl_cleanup_idx")
    assert ttl["keys"] == [("completed_at", 1)]
    assert ttl["expire"] == TOOL_TRACE_TTL_SECONDS
    trace_keys = [index["keys"] for index in database[AGENT_TOOL_TRACES].indexes]
    assert [("expires_at", 1)] not in trace_keys

    events = database[AGENT_EVENTS]
    await events.insert_one({"session_id": "s1", "event_id": "e1"})
    with pytest.raises(DuplicateKeyError):
        await events.insert_one({"session_id": "s1", "event_id": "e1"})
    await events.insert_one({"session_id": "s1", "event_id": "e2"})
    await events.insert_one({"session_id": "s2", "event_id": "e1"})


@pytest.mark.asyncio
async def test_shared_index_conflict_warns_and_other_errors_raise(
    caplog: pytest.LogCaptureFixture,
) -> None:
    database = RecordingDatabase()
    database.failures[FLOW_TASK] = (
        "flow_task_user_idx",
        OperationFailure("index options conflict", code=85),
    )
    with caplog.at_level(logging.WARNING):
        await ensure_indexes(database)

    assert "flow_task_user_idx" in caplog.text
    assert "code=85" in caplog.text
    assert _index(database, AGENT_EVENTS, "session_event_unique_idx")["unique"] is True
    assert FLOW_VERSION in database.operations

    database.failures[FLOW_TASK] = (
        "flow_task_user_idx",
        OperationFailure("index key specs conflict", code=86),
    )
    database.operations.clear()
    await ensure_indexes(database)
    assert database[FLOW_TASK].indexes == []
    assert FLOW_VERSION in database.operations
    assert RESULTS in database.operations

    database.failures[FLOW_TASK] = (
        "flow_task_user_idx",
        OperationFailure("not authorized", code=13),
    )
    with pytest.raises(OperationFailure, match="not authorized"):
        await ensure_indexes(database)


@pytest.mark.asyncio
async def test_startup_calls_ensure_indexes_and_reraises(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[Any] = []

    async def fake_ensure(database: Any) -> None:
        seen.append(database)

    async def fake_rabbit(self: DependencyManager) -> Any:
        return None

    monkeypatch.setattr("novelcomic_agent.dependencies.ensure_indexes", fake_ensure)
    monkeypatch.setattr(DependencyManager, "_ensure_rabbitmq", fake_rabbit)

    settings = Settings()
    manager = DependencyManager(settings)
    original = manager.mongo
    database = object()

    class _Mongo:
        def __getitem__(self, name: str) -> object:
            assert name == settings.mongodb_database
            return database

        async def close(self) -> None:
            return None

    manager.mongo = _Mongo()  # type: ignore[assignment]
    try:
        await manager.start()
        assert seen == [database]

        async def failing_ensure(database: Any) -> None:
            raise OperationFailure("not authorized", code=13)

        monkeypatch.setattr("novelcomic_agent.dependencies.ensure_indexes", failing_ensure)
        with pytest.raises(OperationFailure, match="not authorized"):
            await manager.start()
    finally:
        await original.close()
        await manager.close()
