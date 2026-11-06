"""Workflow snapshot assembled from separate reads.

``get_snapshot`` reads the flow task, the latest run, node states, and the
last sent outbox event. These reads are not wrapped in a Mongo transaction,
so node status may change while the view is being built.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from bson import ObjectId

from app.database.mongo import FLOW_EVENT_OUTBOX, FLOW_NODE_STATE, FLOW_RUN_STATE, FLOW_TASK


def _json_safe(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


async def _latest(
    database: Any,
    collection_name: str,
    query: dict[str, Any],
    field: str,
) -> dict[str, Any] | None:
    cursor = database[collection_name].find(query).sort(field, -1).limit(1)
    async for document in cursor:
        return document
    return None


class WorkflowSnapshotService:
    @classmethod
    async def get_snapshot(cls, database: Any, flow_task_id: str) -> dict[str, Any] | None:
        flow_task = await database[FLOW_TASK].find_one({"flow_task_id": flow_task_id})
        flow_run = await _latest(
            database,
            FLOW_RUN_STATE,
            {"flow_task_id": flow_task_id},
            "updated_at",
        )
        if flow_task is None and flow_run is None:
            return None

        run_id = (flow_run or {}).get("flow_run_id") or (flow_run or {}).get("run_id")
        node_states: list[dict[str, Any]] = []
        if run_id:
            cursor = database[FLOW_NODE_STATE].find({"run_id": run_id}).sort("node_id", 1)
            node_states = [node async for node in cursor]

        last_event = await _latest(
            database,
            FLOW_EVENT_OUTBOX,
            {"flow_task_id": flow_task_id, "status": "sent"},
            "created_at",
        )
        status = (flow_run or {}).get("status") or (flow_task or {}).get("status")
        return _json_safe(
            {
                "protocol_version": 2,
                "flow_task_id": flow_task_id,
                "flow_run_id": run_id,
                "status": status,
                "last_event_id": (last_event or {}).get("event_id"),
                "flow_task": flow_task,
                "flow_run_state": flow_run,
                "flow_node_state": node_states,
            }
        )
