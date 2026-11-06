from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pymongo.errors import DuplicateKeyError

from app.schemas.workflow_runs_v2 import ContinueWorkflowRunRequest, CreateWorkflowRunRequest
from app.services.workflow_runs_v2 import WorkflowRunInvalid, WorkflowRunV2Service


class UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count
        self.modified_count = matched_count


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            if key == "$or":
                if not any(FakeCollection._matches(document, branch) for branch in expected):
                    return False
                continue
            actual = document.get(key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                if "$lte" in expected and (actual is None or actual > expected["$lte"]):
                    return False
                continue
            if actual != expected:
                return False
        return True

    @staticmethod
    def _apply(document: dict[str, Any], update: dict[str, Any]) -> None:
        document.update(deepcopy(update.get("$set", {})))
        for key, value in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + value
        for key in update.get("$unset", {}):
            document.pop(key, None)

    async def insert_one(self, document: dict[str, Any]) -> None:
        next_doc = deepcopy(document)
        next_doc.setdefault("_id", f"fake-{len(self.docs) + 1}")
        for existing in self.docs:
            if (
                existing.get("user_id") == next_doc.get("user_id")
                and existing.get("command_id") == next_doc.get("command_id")
                and next_doc.get("command_id")
            ):
                raise DuplicateKeyError("duplicate")
        self.docs.append(next_doc)

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> UpdateResult:
        for document in self.docs:
            if self._matches(document, query):
                self._apply(document, update)
                return UpdateResult(1)
        return UpdateResult(0)

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        sort: list[tuple[str, int]] | None = None,
        return_document: Any | None = None,
    ) -> dict[str, Any] | None:
        del sort, return_document
        for document in self.docs:
            if self._matches(document, query):
                self._apply(document, update)
                return deepcopy(document)
        return None


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.messages: list[dict[str, Any]] = []

    async def xadd(self, queue_name: str, message: dict[str, Any]) -> str:
        if self.fail:
            raise ConnectionError("redis down")
        self.messages.append({"message": deepcopy(message), "queue_name": queue_name})
        return "1-0"


@pytest.mark.asyncio
async def test_continue_run_dispatches_continue_command() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    dag = {
        "nodes": [{"id": "select", "type": "imageModel"}, {"id": "next", "type": "textInput"}],
        "edges": [{"source": "select", "target": "next"}],
    }
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "created_at": now,
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_task": dag,
            "flow_task_id": "task-1",
            "protocol_version": 2,
            "start_ids": [],
            "status": "waiting_for_selection",
            "trace_id": "trace-1",
            "updated_at": now,
            "user_id": "user-1",
        }
    )
    request = ContinueWorkflowRunRequest(
        command_id="cmd-continue",
        flow_run_id="run-1",
        flow_task=dag,
        user_selection={"select": {"asset": "chosen"}},
    )

    response = await WorkflowRunV2Service.continue_run(
        database=database,
        redis_client=redis,
        user_id="user-1",
        flow_task_id="task-1",
        request=request,
    )

    assert response.status == "running"
    command = await database["workflow_command"].find_one({"command_id": "cmd-continue"})
    assert command is not None
    assert command["status"] == "dispatched"
    run = await database["flow_task"].find_one({"flow_task_id": "task-1"})
    assert run["status"] == "running"
    assert run["user_selection"] == {"select": {"asset": "chosen"}}
    published_payload = redis.messages[0]["message"]["payload"]
    assert '"flow_run_type":"continue"' in published_payload
    assert '"user_selection":{"select":{"asset":"chosen"}}' in published_payload
    assert command["wire_command_id"].startswith("wfc_")
    assert f'"command_id":"{command["wire_command_id"]}"' in published_payload
    assert '"command_id":"cmd-continue"' not in published_payload


@pytest.mark.asyncio
async def test_cancel_run_dispatches_cancel_command() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    now = datetime.now(UTC)
    await database["flow_task"].insert_one(
        {
            "created_at": now,
            "flow_id": "flow-1",
            "flow_run_id": "run-2",
            "flow_task": {"nodes": [], "edges": []},
            "flow_task_id": "task-2",
            "protocol_version": 2,
            "start_ids": [],
            "status": "running",
            "trace_id": "trace-2",
            "updated_at": now,
            "user_id": "user-1",
        }
    )

    response = await WorkflowRunV2Service.cancel_run(
        database=database,
        redis_client=redis,
        user_id="user-1",
        flow_task_id="task-2",
        command_id="cmd-cancel",
    )

    assert response.status == "cancel_requested"
    command = await database["workflow_command"].find_one({"command_id": "cmd-cancel"})
    assert command is not None
    assert command["status"] == "dispatched"
    run = await database["flow_task"].find_one({"flow_task_id": "task-2"})
    assert run["status"] == "cancel_requested"
    assert run["cancel_command_id"] == "cmd-cancel"
    published_payload = redis.messages[0]["message"]["payload"]
    assert '"flow_run_type":"cancel"' in published_payload
    assert '"flow_task_id":"task-2"' in published_payload
    assert command["wire_command_id"].startswith("wfc_")
    assert f'"command_id":"{command["wire_command_id"]}"' in published_payload
    assert '"command_id":"cmd-cancel"' not in published_payload


def _start_request(command_id: str) -> CreateWorkflowRunRequest:
    return CreateWorkflowRunRequest(
        client_request_id=command_id,
        command_id=command_id,
        flow_id="flow-1",
        flow_task={"nodes": [{"id": "n"}], "edges": []},
    )


@pytest.mark.asyncio
async def test_redis_failure_keeps_the_same_command_id_for_retry() -> None:
    database = FakeDatabase()
    redis = FakeRedis(fail=True)

    created = await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=redis,
        request=_start_request("cmd-1"),
        user_id="user-a",
    )

    command = await database["workflow_command"].find_one({"command_id": "cmd-1"})
    run = await database["flow_task"].find_one({"flow_task_id": created.flow_task_id})
    assert command is not None
    assert command["status"] == "pending"
    assert command["command_id"] == "cmd-1"
    assert run["dispatch_state"] == "pending_retry"
    assert len(database["workflow_command"].docs) == 1

    for stored in database["workflow_command"].docs:
        stored["next_attempt_at"] = datetime.now(UTC) - timedelta(seconds=1)
    redis.fail = False
    assert await WorkflowRunV2Service.dispatch_command(
        database=database,
        redis_client=redis,
        user_id="user-a",
        command_id="cmd-1",
    )
    recovered = await database["workflow_command"].find_one({"user_id": "user-a", "command_id": "cmd-1"})
    assert recovered is not None
    assert recovered["status"] == "dispatched"
    assert len(database["workflow_command"].docs) == 1
    published_payload = redis.messages[0]["message"]["payload"]
    assert f'"command_id":"{recovered["wire_command_id"]}"' in published_payload


@pytest.mark.asyncio
async def test_due_dispatch_retries_the_original_command_id() -> None:
    database = FakeDatabase()
    redis = FakeRedis(fail=True)

    await WorkflowRunV2Service.create_run(
        database=database,
        redis_client=redis,
        request=_start_request("cmd-due"),
        user_id="user-a",
    )

    command = await database["workflow_command"].find_one({"command_id": "cmd-due"})
    run = await database["flow_task"].find_one({"user_id": "user-a"})
    assert command is not None
    assert run is not None
    assert command["status"] == "pending"
    assert command["command_id"] == "cmd-due"
    assert run["dispatch_state"] == "pending_retry"
    assert len(database["workflow_command"].docs) == 1
    assert "flow_command_inbox" not in database.collections

    for stored in database["workflow_command"].docs:
        stored["next_attempt_at"] = datetime.now(UTC) - timedelta(seconds=1)
    redis.fail = False
    dispatched = await WorkflowRunV2Service.dispatch_due_commands(
        database=database,
        redis_client=redis,
    )

    assert dispatched == 1
    recovered = await database["workflow_command"].find_one({"command_id": "cmd-due"})
    assert recovered is not None
    assert recovered["status"] == "dispatched"
    assert recovered["command_id"] == "cmd-due"
    assert len(database["workflow_command"].docs) == 1
    assert "flow_command_inbox" not in database.collections
    assert len(redis.messages) == 1


@pytest.mark.asyncio
async def test_claim_is_scoped_to_the_user_and_only_one_dispatcher_wins() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    now = datetime.now(UTC)
    for user_id, task_id in (("user-a", "task-a"), ("user-b", "task-b")):
        await database["flow_task"].insert_one(
            {
                "flow_run_id": f"run-{user_id}",
                "flow_task": {"nodes": [], "edges": []},
                "flow_task_id": task_id,
                "protocol_version": 2,
                "status": "pending",
                "trace_id": f"trace-{user_id}",
                "user_id": user_id,
            }
        )
        await database["workflow_command"].insert_one(
            {
                "attempts": 0,
                "command_id": "cmd-shared",
                "command_type": "start",
                "flow_run_id": f"run-{user_id}",
                "flow_task_id": task_id,
                "next_attempt_at": now,
                "payload": {
                    "command_type": "start",
                    "request": {"flow_task": {"nodes": [], "edges": []}},
                },
                "status": "pending",
                "trace_id": f"trace-{user_id}",
                "user_id": user_id,
                "wire_command_id": WorkflowRunV2Service._wire_command_id(user_id, "cmd-shared"),
            }
        )

    assert await WorkflowRunV2Service.dispatch_command(
        database=database,
        redis_client=redis,
        user_id="user-a",
        command_id="cmd-shared",
    )
    user_b = await database["workflow_command"].find_one({"user_id": "user-b", "command_id": "cmd-shared"})
    assert user_b is not None
    assert user_b["status"] == "pending"
    assert len(redis.messages) == 1

    first, second = await asyncio.gather(
        WorkflowRunV2Service.dispatch_command(
            database=database,
            redis_client=redis,
            user_id="user-b",
            command_id="cmd-shared",
        ),
        WorkflowRunV2Service.dispatch_command(
            database=database,
            redis_client=redis,
            user_id="user-b",
            command_id="cmd-shared",
        ),
    )
    assert sorted([first, second]) == [False, True]


@pytest.mark.asyncio
async def test_due_dispatch_continues_after_one_command_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    database = FakeDatabase()
    now = datetime.now(UTC)
    for command_id in ("cmd-a", "cmd-b"):
        await database["workflow_command"].insert_one(
            {
                "attempts": 0,
                "command_id": command_id,
                "command_type": "start",
                "flow_task_id": command_id,
                "next_attempt_at": now,
                "status": "pending",
                "user_id": "user-a",
            }
        )

    seen: list[str] = []

    async def fail_first(_database: Any, _redis: Any, command: dict[str, Any]) -> None:
        seen.append(command["command_id"])
        if len(seen) == 1:
            raise RuntimeError("redis down")

    monkeypatch.setattr(WorkflowRunV2Service, "_dispatch_claimed", fail_first)
    dispatched = await WorkflowRunV2Service.dispatch_due_commands(
        database=database,
        redis_client=object(),
    )

    assert seen == ["cmd-a", "cmd-b"]
    assert dispatched == 1


@pytest.mark.asyncio
async def test_create_run_rejects_nodes_that_are_not_an_array() -> None:
    database = FakeDatabase()
    with pytest.raises(WorkflowRunInvalid, match="arrays"):
        await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=FakeRedis(),
            request=CreateWorkflowRunRequest(
                client_request_id="cmd-bad",
                command_id="cmd-bad",
                flow_id="flow-1",
                flow_task={"nodes": "nope", "edges": []},
            ),
            user_id="user-a",
        )
    assert database["flow_task"].docs == []
    assert database["workflow_command"].docs == []
