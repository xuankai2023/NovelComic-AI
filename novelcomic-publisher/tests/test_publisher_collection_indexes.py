"""Publisher 集合索引、启动顺序，以及 create_run 事务。"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock

import pytest
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.core.register import register_init
from app.database.mongo import (
    FLOW_RUN_STATE,
    FLOW_TASK,
    SUBSCRIPTION_CHECKOUT_INTENT,
    WORKFLOW_COMMAND,
    ensure_workflow_v2_indexes,
    owner_collections,
)
from app.main import lifespan
from app.schemas.workflow_runs_v2 import ContinueWorkflowRunRequest, CreateWorkflowRunRequest
from app.services.workflow_runs_v2 import (
    WorkflowRunConflict,
    WorkflowRunInvalid,
    WorkflowRunV2Service,
)


def _path(document: dict[str, Any], field: str) -> Any:
    current: Any = document
    for part in field.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _partial_matches(document: dict[str, Any], expression: dict[str, Any] | None) -> bool:
    if not expression:
        return True
    for field, expected in expression.items():
        actual = _path(document, field)
        if isinstance(expected, dict) and set(expected) == {"$type"}:
            if expected["$type"] == "string" and not isinstance(actual, str):
                return False
            continue
        if actual != expected:
            return False
    return True


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, expected in query.items():
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$nin" in expected:
                if actual in expected["$nin"]:
                    return False
                continue
            if "$in" in expected:
                if actual not in expected["$in"]:
                    return False
                continue
            if "$ne" in expected:
                if actual == expected["$ne"]:
                    return False
                continue
        if actual != expected:
            return False
    return True


def _normalize_keys(keys: Any) -> list[tuple[str, int]]:
    if isinstance(keys, str):
        return [(keys, 1)]
    return [(field, direction) for field, direction in keys]


class _UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count


class _Session:
    def __init__(self, database: RecordingDatabase) -> None:
        self.database = database
        self.pending: list[tuple[str, dict[str, Any]]] | None = None
        self.pending_updates: list[tuple[str, dict[str, Any], dict[str, Any]]] | None = None

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        return False

    def start_transaction(self) -> _Transaction:
        return _Transaction(self)


class _Transaction:
    def __init__(self, session: _Session) -> None:
        self.session = session

    async def __aenter__(self) -> _Transaction:
        self.session.pending = []
        self.session.pending_updates = []
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        pending = self.session.pending or []
        updates = self.session.pending_updates or []
        self.session.pending = None
        self.session.pending_updates = None
        if exc_type is None:
            for name, document in pending:
                self.session.database._commit(name, document)
            for name, query, update in updates:
                await self.session.database[name].update_one(query, update)
        return False


class _Client:
    def __init__(self, database: RecordingDatabase) -> None:
        self.database = database

    async def start_session(self) -> _Session:
        return _Session(self.database)


class RecordingCollection:
    def __init__(self, database: RecordingDatabase, name: str) -> None:
        self.database = database
        self.name = name
        self.docs: list[dict[str, Any]] = []
        self.indexes: list[dict[str, Any]] = []

    async def drop_index(self, name: str) -> None:
        self.database.operations.append(("drop_index", self.name, name))
        raise LookupError(name)

    async def create_index(self, keys: Any, **kwargs: Any) -> str:
        spec = {
            "keys": _normalize_keys(keys),
            "name": kwargs.get("name"),
            "unique": bool(kwargs.get("unique")),
            "partial": kwargs.get("partialFilterExpression"),
            "expire": kwargs.get("expireAfterSeconds"),
        }
        existing = next((item for item in self.indexes if item["name"] == spec["name"]), None)
        if existing is not None and existing != spec:
            raise RuntimeError(f"index spec changed: {spec['name']}")
        if existing is None:
            self.indexes.append(spec)
        self.database.operations.append(("create_index", self.name, spec["name"]))
        return str(spec["name"])

    async def update_many(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        self.database.operations.append(("update_many", self.name, query))
        for document in self.docs:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            for key in update.get("$unset", {}):
                document.pop(key, None)

    def _conflicts(self, document: dict[str, Any], pending: list[dict[str, Any]]) -> bool:
        for index in self.indexes:
            if not index["unique"] or not _partial_matches(document, index["partial"]):
                continue
            key = tuple(_path(document, field) for field, _direction in index["keys"])
            for existing in [*self.docs, *pending]:
                if not _partial_matches(existing, index["partial"]):
                    continue
                existing_key = tuple(_path(existing, field) for field, _direction in index["keys"])
                if existing_key == key:
                    return True
        return False

    async def insert_one(self, document: dict[str, Any], session: _Session | None = None) -> None:
        if self.database.fail_inserts.get(self.name):
            self.database.fail_inserts[self.name] = False
            raise RuntimeError(f"{self.name} insert failed")
        stored = deepcopy(document)
        pending: list[dict[str, Any]] = []
        if session is not None and session.pending is not None:
            pending = [item for name, item in session.pending if name == self.name]
        if self._conflicts(stored, pending):
            raise DuplicateKeyError("duplicate key")
        if session is not None and session.pending is not None:
            session.pending.append((self.name, stored))
            return
        self.database._commit(self.name, stored)

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if _matches(document, query):
                return deepcopy(document)
        return None

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        session: _Session | None = None,
    ) -> _UpdateResult:
        if self.database.fail_updates.get(self.name):
            self.database.fail_updates[self.name] = False
            return _UpdateResult(0)
        if session is not None and session.pending_updates is not None:
            matched = any(_matches(document, query) for document in self.docs)
            if matched:
                session.pending_updates.append((self.name, deepcopy(query), deepcopy(update)))
            return _UpdateResult(1 if matched else 0)
        for document in self.docs:
            if not _matches(document, query):
                continue
            document.update(deepcopy(update.get("$set", {})))
            for key in update.get("$unset", {}):
                document.pop(key, None)
            return _UpdateResult(1)
        return _UpdateResult(0)

    async def delete_one(self, query: dict[str, Any]) -> None:
        self.docs[:] = [document for document in self.docs if not _matches(document, query)]


class RecordingDatabase:
    def __init__(self, *, transactions: bool = True) -> None:
        self.collections: dict[str, RecordingCollection] = {}
        self.operations: list[tuple[Any, ...]] = []
        self.fail_ping = False
        self.fail_inserts: dict[str, bool] = {}
        self.fail_updates: dict[str, bool] = {}
        self._client = _Client(self)
        self._transactions = transactions

    def __getitem__(self, name: str) -> RecordingCollection:
        if name not in self.collections:
            self.collections[name] = RecordingCollection(self, name)
        return self.collections[name]

    @property
    def client(self) -> _Client | None:
        if not self._transactions:
            return None
        return self._client

    async def list_collection_names(self) -> list[str]:
        if self.fail_ping:
            raise ConnectionError("mongodb down")
        return list(self.collections)

    def _commit(self, name: str, document: dict[str, Any]) -> None:
        self[name].docs.append(document)


def _index(database: RecordingDatabase, collection: str, name: str) -> dict[str, Any]:
    return next(item for item in database[collection].indexes if item["name"] == name)


def _run_request(command_id: str, text: str = "hello") -> CreateWorkflowRunRequest:
    return CreateWorkflowRunRequest(
        client_request_id=command_id,
        command_id=command_id,
        flow_id="flow-1",
        flow_task={"nodes": [{"id": "n", "data": {"text": text}}], "edges": []},
    )


@pytest.mark.asyncio
async def test_workflow_v2_indexes_are_idempotent_and_reject_duplicate_commands() -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    index_count = len(database[WORKFLOW_COMMAND].indexes)
    await ensure_workflow_v2_indexes(database)
    assert len(database[WORKFLOW_COMMAND].indexes) == index_count == 4

    command_unique = _index(database, WORKFLOW_COMMAND, "workflow_command_user_command_unique")
    assert command_unique["unique"] is True
    assert command_unique["keys"] == [("user_id", 1), ("command_id", 1)]
    assert command_unique["partial"] is None

    wire = _index(database, WORKFLOW_COMMAND, "workflow_command_wire_unique")
    assert wire["unique"] is True
    assert wire["partial"] == {"wire_command_id": {"$type": "string"}}
    due = _index(database, WORKFLOW_COMMAND, "workflow_command_dispatch_due")
    assert due["keys"] == [("status", 1), ("next_attempt_at", 1), ("updated_at", 1)]
    ttl = _index(database, WORKFLOW_COMMAND, "workflow_command_terminal_ttl")
    assert ttl["expire"] == 0

    task_unique = _index(database, FLOW_TASK, "flow_task_user_client_request_unique")
    assert task_unique["unique"] is True
    assert task_unique["partial"] == {"client_request_id": {"$type": "string"}}

    commands = database[WORKFLOW_COMMAND]
    await commands.insert_one({"user_id": "user-a", "command_id": "cmd-1"})
    with pytest.raises(DuplicateKeyError):
        await commands.insert_one({"user_id": "user-a", "command_id": "cmd-1"})
    await commands.insert_one({"user_id": "user-b", "command_id": "cmd-1"})
    await commands.insert_one({"user_id": "user-c", "command_id": "cmd-2"})
    await commands.insert_one({"user_id": "user-d", "command_id": "cmd-3", "wire_command_id": None})
    await commands.insert_one({"user_id": "user-e", "command_id": "cmd-4", "wire_command_id": 7})
    await commands.insert_one(
        {"user_id": "user-f", "command_id": "cmd-5", "wire_command_id": "wire-1"}
    )
    with pytest.raises(DuplicateKeyError):
        await commands.insert_one(
            {"user_id": "user-g", "command_id": "cmd-6", "wire_command_id": "wire-1"}
        )

    tasks = database[FLOW_TASK]
    await tasks.insert_one({"user_id": "user-a"})
    await tasks.insert_one({"user_id": "user-a", "client_request_id": None})
    await tasks.insert_one({"user_id": "user-a", "client_request_id": "req-1"})
    with pytest.raises(DuplicateKeyError):
        await tasks.insert_one({"user_id": "user-a", "client_request_id": "req-1"})
    await tasks.insert_one({"user_id": "user-b", "client_request_id": "req-1"})


@pytest.mark.asyncio
async def test_owner_handles_include_shared_run_state_without_publisher_migration() -> None:
    database = RecordingDatabase()
    handles = owner_collections(database)
    assert handles.flow_task is database[FLOW_TASK]
    assert handles.workflow_command is database[WORKFLOW_COMMAND]
    assert handles.flow_run_state is database[FLOW_RUN_STATE]
    assert handles.user is database["users"]
    assert handles.orders is database["orders"]
    assert handles.credits_inout_record is database["credits_inout_record"]
    assert handles.media_face_verifications is database["media_face_verifications"]
    assert "迁移不在 Publisher" in (owner_collections.__doc__ or "")


@pytest.mark.asyncio
async def test_register_init_builds_indexes_and_clears_live_checkout_expiry() -> None:
    database = RecordingDatabase()
    await database[SUBSCRIPTION_CHECKOUT_INTENT].insert_one(
        {"request_id": "live", "state": "pending", "expires_at": "soon"}
    )
    await database[SUBSCRIPTION_CHECKOUT_INTENT].insert_one(
        {"request_id": "done", "state": "completed", "expires_at": "keep"}
    )

    await register_init(database)
    await register_init(database)

    names = [op[2] for op in database.operations if op[0] == "create_index"]
    assert names.index("developer_api_client_api_key_hash_unique") < names.index(
        "invite_codes_invite_code_unique"
    )
    assert names.index("invite_codes_invite_code_unique") < names.index(
        "credits_inout_user_direction_created"
    )
    assert names.index("credits_inout_idempotency_unique") < names.index(
        "subscription_checkout_intent_expires_at_ttl"
    )
    assert names.index("b2b_signal_events_event_id_unique") < names.index(
        "media_face_verifications_user_media_unique"
    )
    assert names.index("user_preferences_user_id_unique") < names.index(
        "asset_library_items_asset_id_unique"
    )
    assert names.index("agent_skills_skill_id_unique") < names.index(
        "agent_catalog_hook_id_unique"
    )
    assert names.index("agent_catalog_hook_id_unique") < names.index(
        "workflow_command_user_command_unique"
    )
    assert "workflow_command_wire_unique" in names

    unset_at = next(
        index
        for index, op in enumerate(database.operations)
        if op[0] == "update_many" and op[1] == SUBSCRIPTION_CHECKOUT_INTENT
    )
    ttl_at = next(
        index
        for index, op in enumerate(database.operations)
        if op[0] == "create_index" and op[2] == "subscription_checkout_intent_expires_at_ttl"
    )
    assert unset_at < ttl_at

    live = await database[SUBSCRIPTION_CHECKOUT_INTENT].find_one({"request_id": "live"})
    done = await database[SUBSCRIPTION_CHECKOUT_INTENT].find_one({"request_id": "done"})
    assert live is not None and "expires_at" not in live
    assert done is not None and done["expires_at"] == "keep"
    assert any(op[0] == "drop_index" for op in database.operations)


@pytest.mark.asyncio
async def test_register_init_stops_when_mongo_ping_fails() -> None:
    database = RecordingDatabase()
    database.fail_ping = True
    with pytest.raises(RuntimeError, match="mongodb connection failed"):
        await register_init(database)
    assert database.operations == []


@pytest.mark.asyncio
async def test_create_run_commits_both_rows_and_replays_same_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    dispatch = AsyncMock(return_value=True)
    monkeypatch.setattr(WorkflowRunV2Service, "dispatch_command", dispatch)

    created = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=object(),
        request=_run_request("cmd-1"),
        user_id="user-a",
    )
    replay = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=object(),
        request=_run_request("cmd-1"),
        user_id="user-a",
    )
    other_user = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=object(),
        request=_run_request("cmd-1"),
        user_id="user-b",
    )

    assert created.idempotent_replay is False
    assert created.status == "pending"
    assert replay.idempotent_replay is True
    assert replay.flow_task_id == created.flow_task_id
    assert other_user.flow_task_id != created.flow_task_id
    assert len(database[FLOW_TASK].docs) == 2
    assert len(database[WORKFLOW_COMMAND].docs) == 2
    assert dispatch.await_count == 2

    with pytest.raises(WorkflowRunConflict):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=object(),
            request=_run_request("cmd-1", text="changed"),
            user_id="user-a",
        )
    assert len(database[FLOW_TASK].docs) == 2
    assert dispatch.await_count == 2


@pytest.mark.asyncio
async def test_create_run_transaction_failure_leaves_neither_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    database.fail_inserts[WORKFLOW_COMMAND] = True
    dispatch = AsyncMock(return_value=True)
    monkeypatch.setattr(WorkflowRunV2Service, "dispatch_command", dispatch)

    with pytest.raises(RuntimeError, match="workflow_command insert failed"):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=object(),
            request=_run_request("cmd-fail"),
            user_id="user-a",
        )

    assert database[FLOW_TASK].docs == []
    assert database[WORKFLOW_COMMAND].docs == []
    assert dispatch.await_count == 0


@pytest.mark.asyncio
async def test_create_run_without_session_discards_task_when_command_insert_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = RecordingDatabase(transactions=False)
    database.fail_inserts[WORKFLOW_COMMAND] = True
    dispatch = AsyncMock(return_value=True)
    monkeypatch.setattr(WorkflowRunV2Service, "dispatch_command", dispatch)

    with pytest.raises(RuntimeError, match="workflow_command insert failed"):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=object(),
            request=_run_request("cmd-fail"),
            user_id="user-a",
        )

    assert database[FLOW_TASK].docs == []
    assert database[WORKFLOW_COMMAND].docs == []
    assert dispatch.await_count == 0


@pytest.mark.asyncio
async def test_create_run_rejects_a_cycle_before_either_row_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    dispatch = AsyncMock(return_value=True)
    monkeypatch.setattr(WorkflowRunV2Service, "dispatch_command", dispatch)
    request = CreateWorkflowRunRequest(
        client_request_id="cmd-cycle",
        command_id="cmd-cycle",
        flow_id="flow-1",
        flow_task={
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [
                {"source": "a", "target": "b"},
                {"source": "b", "target": "a"},
            ],
        },
    )

    with pytest.raises(WorkflowRunInvalid, match="cycle"):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=object(),
            request=request,
            user_id="user-a",
        )

    assert database[FLOW_TASK].docs == []
    assert database[WORKFLOW_COMMAND].docs == []
    assert dispatch.await_count == 0


@pytest.mark.asyncio
async def test_create_run_aliases_a_new_command_onto_the_same_client_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    dispatch = AsyncMock(return_value=True)
    monkeypatch.setattr(WorkflowRunV2Service, "dispatch_command", dispatch)

    created = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=object(),
        request=_run_request("cmd-1"),
        user_id="user-a",
    )
    alias = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=object(),
        request=CreateWorkflowRunRequest(
            client_request_id="cmd-1",
            command_id="cmd-2",
            flow_id="flow-1",
            flow_task={"nodes": [{"id": "n", "data": {"text": "hello"}}], "edges": []},
        ),
        user_id="user-a",
    )

    assert alias.idempotent_replay is True
    assert alias.flow_task_id == created.flow_task_id
    assert len(database[FLOW_TASK].docs) == 1
    assert len(database[WORKFLOW_COMMAND].docs) == 2
    assert database[WORKFLOW_COMMAND].docs[1]["status"] == "dispatched"
    assert database[WORKFLOW_COMMAND].docs[1]["wire_command_id"].startswith("wfc_")
    assert dispatch.await_count == 1

    with pytest.raises(WorkflowRunConflict, match="client_request_id"):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=object(),
            request=CreateWorkflowRunRequest(
                client_request_id="cmd-1",
                command_id="cmd-3",
                flow_id="flow-1",
                flow_task={"nodes": [{"id": "n", "data": {"text": "changed"}}], "edges": []},
            ),
            user_id="user-a",
        )
    assert len(database[FLOW_TASK].docs) == 1
    assert len(database[WORKFLOW_COMMAND].docs) == 2


async def _waiting_run(database: RecordingDatabase) -> None:
    now = datetime.now(UTC)
    await database[FLOW_TASK].insert_one(
        {
            "created_at": now,
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "status": "waiting_for_selection",
            "trace_id": "trace-1",
            "updated_at": now,
            "user_id": "user-a",
        }
    )


def _continue_request() -> ContinueWorkflowRunRequest:
    return ContinueWorkflowRunRequest(
        command_id="cmd-continue",
        flow_run_id="run-1",
        flow_task={"nodes": [{"id": "n"}], "edges": []},
    )


@pytest.mark.asyncio
async def test_continue_run_rolls_back_the_command_when_the_run_update_misses() -> None:
    database = RecordingDatabase()
    await ensure_workflow_v2_indexes(database)
    await _waiting_run(database)
    database.fail_updates[FLOW_TASK] = True

    with pytest.raises(WorkflowRunConflict, match="no longer continuable"):
        await WorkflowRunV2Service.continue_run(
            database=database,
            redis_client=object(),
            user_id="user-a",
            flow_task_id="task-1",
            request=_continue_request(),
        )

    assert database[WORKFLOW_COMMAND].docs == []
    assert database[FLOW_TASK].docs[0]["status"] == "waiting_for_selection"


@pytest.mark.asyncio
async def test_continue_run_without_session_deletes_the_command_when_the_update_misses() -> None:
    database = RecordingDatabase(transactions=False)
    await _waiting_run(database)
    database.fail_updates[FLOW_TASK] = True

    with pytest.raises(WorkflowRunConflict, match="no longer continuable"):
        await WorkflowRunV2Service.continue_run(
            database=database,
            redis_client=object(),
            user_id="user-a",
            flow_task_id="task-1",
            request=_continue_request(),
        )

    assert database[WORKFLOW_COMMAND].docs == []
    assert database[FLOW_TASK].docs[0]["status"] == "waiting_for_selection"


@pytest.mark.asyncio
async def test_lifespan_ensures_indexes_before_dispatcher(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    database_name = get_settings().mongo_database

    class _Connections:
        def __init__(self) -> None:
            self.mongo = {database_name: {"ready": True}}
            self.redis = None
            self.rabbitmq_url = "amqp://example"
            self.timeout = 1.0

        async def close(self) -> None:
            order.append("close")

    async def connect(_settings: Any) -> _Connections:
        order.append("connect")
        return _Connections()

    async def init(database: Any) -> None:
        order.append("indexes")
        assert database == {"ready": True}

    async def dispatcher(_database: Any, _redis: Any) -> None:
        order.append("dispatcher")
        await asyncio.Event().wait()

    async def result_consumer(**_kwargs: Any) -> None:
        order.append("result_consumer")
        await asyncio.Event().wait()

    monkeypatch.setattr("app.main.Connections.connect", connect)
    monkeypatch.setattr("app.main.register_init", init)
    monkeypatch.setattr("app.main.workflow_command_dispatcher_forever", dispatcher)
    monkeypatch.setattr("app.main.run_main_result_consumers", result_consumer)

    async with lifespan(AsyncMock()):
        await asyncio.sleep(0)
        assert order == ["connect", "indexes", "result_consumer", "dispatcher"]
    assert order[-1] == "close"


@pytest.mark.asyncio
async def test_lifespan_does_not_start_dispatcher_when_indexes_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    async def init(_database: Any) -> None:
        order.append("indexes")
        raise RuntimeError("index failed")

    async def dispatcher(_database: Any, _redis: Any) -> None:
        order.append("dispatcher")

    monkeypatch.setattr("app.main.Connections.connect", connect)
    monkeypatch.setattr("app.main.register_init", init)
    monkeypatch.setattr("app.main.workflow_command_dispatcher_forever", dispatcher)

    with pytest.raises(RuntimeError, match="index failed"):
        async with lifespan(AsyncMock()):
            pass
    assert order == ["connect", "indexes", "close"]
