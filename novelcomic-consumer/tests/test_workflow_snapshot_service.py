from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from bson import ObjectId
from test_workflow_dag_execution import FakeDatabase

from app.database.mongo import FLOW_EVENT_OUTBOX, FLOW_NODE_STATE, FLOW_RUN_STATE, FLOW_TASK
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.services.workflow.workflow_snapshot_service import WorkflowSnapshotService


class _SessionGuard:
    """Fake database that fails if snapshot opens a Mongo session."""

    def __init__(self, database: FakeDatabase) -> None:
        self.database = database
        self.sessions = 0

    def start_session(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs
        self.sessions += 1
        raise AssertionError("snapshot must not open a mongo session")

    def __getitem__(self, name: str) -> Any:
        collection = self.database[name]
        if name != FLOW_RUN_STATE:
            return collection
        return _RunReadFlipsNode(collection, self.database)


class _RunReadFlipsNode:
    def __init__(self, collection: Any, database: FakeDatabase) -> None:
        self.collection = collection
        self.database = database

    def find(self, query: dict[str, Any]) -> Any:
        for document in self.database[FLOW_NODE_STATE].docs.values():
            if document.get("node_id") == "node-a":
                document["status"] = "success"
        return self.collection.find(query)


def _task(flow_task_id: str, **fields: Any) -> dict[str, Any]:
    document = {
        "_id": ObjectId(),
        "flow_task_id": flow_task_id,
        "status": "queued",
    }
    document.update(fields)
    return document


def _run(flow_task_id: str, run_id: str, **fields: Any) -> dict[str, Any]:
    document = {
        "_id": run_id,
        "flow_run_id": run_id,
        "flow_task_id": flow_task_id,
        "run_id": run_id,
        "status": "running",
        "updated_at": datetime(2026, 9, 30, 8, 0, tzinfo=UTC),
    }
    document.update(fields)
    return document


@pytest.mark.asyncio
async def test_snapshot_returns_latest_run_nodes_and_last_sent_event() -> None:
    database = FakeDatabase()
    task_id = ObjectId()
    await database[FLOW_TASK].insert_one(
        {
            "_id": task_id,
            "flow_task_id": "task-1",
            "status": "queued",
            "updated_at": datetime(2026, 9, 30, 7, 0, tzinfo=UTC),
        }
    )
    await database[FLOW_RUN_STATE].insert_one(
        _run(
            "task-1",
            "run-old",
            status="failed",
            updated_at=datetime(2026, 9, 29, 8, 0, tzinfo=UTC),
        )
    )
    await database[FLOW_RUN_STATE].insert_one(_run("task-1", "run-new", status="running"))
    await database[FLOW_NODE_STATE].insert_one(
        {"_id": "run-new:b", "node_id": "node-b", "run_id": "run-new", "status": "idle"}
    )
    await database[FLOW_NODE_STATE].insert_one(
        {"_id": "run-new:a", "node_id": "node-a", "run_id": "run-new", "status": "running"}
    )
    await database[FLOW_NODE_STATE].insert_one(
        {"_id": "run-old:a", "node_id": "node-a", "run_id": "run-old", "status": "failed"}
    )
    await database[FLOW_EVENT_OUTBOX].insert_one(
        {
            "_id": "evt-failed",
            "created_at": datetime(2026, 9, 30, 9, 0, tzinfo=UTC),
            "event_id": "evt-failed",
            "flow_task_id": "task-1",
            "status": "failed",
        }
    )
    await database[FLOW_EVENT_OUTBOX].insert_one(
        {
            "_id": "evt-old",
            "created_at": datetime(2026, 9, 30, 7, 0, tzinfo=UTC),
            "event_id": "evt-old",
            "flow_task_id": "task-1",
            "status": "sent",
        }
    )
    await database[FLOW_EVENT_OUTBOX].insert_one(
        {
            "_id": "evt-sent",
            "created_at": datetime(2026, 9, 30, 8, 30, tzinfo=UTC),
            "event_id": "evt-sent",
            "flow_task_id": "task-1",
            "status": "sent",
        }
    )

    snapshot = await WorkflowSnapshotService.get_snapshot(database, "task-1")

    assert snapshot is not None
    assert snapshot["protocol_version"] == 2
    assert snapshot["flow_task_id"] == "task-1"
    assert snapshot["flow_run_id"] == "run-new"
    assert snapshot["status"] == "running"
    assert snapshot["last_event_id"] == "evt-sent"
    assert [node["node_id"] for node in snapshot["flow_node_state"]] == ["node-a", "node-b"]
    assert snapshot["flow_task"]["_id"] == str(task_id)
    assert snapshot["flow_run_state"]["updated_at"] == "2026-09-30T08:00:00+00:00"
    assert FlowRunStateService.COLLECTION == FLOW_RUN_STATE


@pytest.mark.asyncio
async def test_snapshot_uses_task_when_run_is_missing_and_empty_when_both_are_missing() -> None:
    database = FakeDatabase()
    await database[FLOW_TASK].insert_one(_task("task-only", status="running"))
    await database[FLOW_NODE_STATE].insert_one(
        {"_id": "orphan-node", "node_id": "node-a", "run_id": "run-x", "status": "running"}
    )
    await database[FLOW_EVENT_OUTBOX].insert_one(
        {
            "_id": "evt-other",
            "created_at": datetime(2026, 9, 30, 8, 0, tzinfo=UTC),
            "event_id": "evt-other",
            "flow_task_id": "task-missing",
            "status": "sent",
        }
    )

    task_only = await WorkflowSnapshotService.get_snapshot(database, "task-only")
    missing = await WorkflowSnapshotService.get_snapshot(database, "task-missing")

    assert task_only is not None
    assert task_only["protocol_version"] == 2
    assert task_only["flow_run_id"] is None
    assert task_only["status"] == "running"
    assert task_only["flow_node_state"] == []
    assert task_only["last_event_id"] is None
    assert missing is None


@pytest.mark.asyncio
async def test_snapshot_allows_state_to_change_between_reads() -> None:
    database = FakeDatabase()
    await database[FLOW_TASK].insert_one(_task("task-1", status="running"))
    await database[FLOW_RUN_STATE].insert_one(_run("task-1", "run-1"))
    await database[FLOW_NODE_STATE].insert_one(
        {"_id": "run-1:a", "node_id": "node-a", "run_id": "run-1", "status": "running"}
    )
    guarded = _SessionGuard(database)

    snapshot = await WorkflowSnapshotService.get_snapshot(guarded, "task-1")

    assert guarded.sessions == 0
    assert snapshot is not None
    assert snapshot["protocol_version"] == 2
    assert snapshot["flow_node_state"][0]["status"] == "success"
    assert snapshot["flow_run_id"] == "run-1"
    assert snapshot["status"] == "running"
