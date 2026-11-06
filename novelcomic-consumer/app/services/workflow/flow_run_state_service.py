"""Workflow run state persistence for Consumer execution."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings
from app.database.mongo import FLOW_RUN_STATE


class FlowRunStateService:
    COLLECTION = FLOW_RUN_STATE

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _node_id(node: dict[str, Any]) -> str:
        return str(node.get("id") or node.get("node_id") or "")

    @classmethod
    def active_node_ids(
        cls,
        dag: dict[str, Any],
        *,
        start_ids: list[str] | None = None,
        end_ids: list[str] | None = None,
    ) -> set[str]:
        nodes = dag.get("nodes") or []
        edges = dag.get("edges") or dag.get("links") or []
        node_ids = {cls._node_id(node) for node in nodes if cls._node_id(node)}
        if not node_ids:
            return set()

        successors: dict[str, list[str]] = defaultdict(list)
        predecessors: dict[str, list[str]] = defaultdict(list)
        for edge in edges:
            source = str(edge.get("source") or "")
            target = str(edge.get("target") or "")
            if source in node_ids and target in node_ids:
                successors[source].append(target)
                predecessors[target].append(source)

        starts = [node_id for node_id in (start_ids or []) if node_id in node_ids]
        ends = {node_id for node_id in (end_ids or []) if node_id in node_ids}
        if not starts:
            starts = sorted(node_ids)

        reachable: set[str] = set()
        queue: deque[str] = deque(starts)
        while queue:
            node_id = queue.popleft()
            if node_id in reachable:
                continue
            reachable.add(node_id)
            if ends and node_id in ends:
                continue
            queue.extend(successors.get(node_id, []))

        if not ends:
            return reachable

        can_reach_end: set[str] = set()
        queue = deque(ends)
        while queue:
            node_id = queue.popleft()
            if node_id in can_reach_end:
                continue
            can_reach_end.add(node_id)
            queue.extend(predecessors.get(node_id, []))
        return reachable & can_reach_end

    @classmethod
    async def init_flow_run(
        cls,
        database: Any,
        *,
        run_id: str,
        flow_task_id: str,
        user_id: str,
        ws_id: str,
        dag: dict[str, Any],
        start_ids: list[str] | None = None,
        end_ids: list[str] | None = None,
        reply_queue: str | None = None,
        trace_id: str | None = None,
        flow_id: str | None = None,
        locale: str | None = None,
        command_id: str | None = None,
        protocol_version: int | None = None,
        user_selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = cls._now()
        active_node_ids = cls.active_node_ids(dag, start_ids=start_ids, end_ids=end_ids)
        selected_outputs = user_selection or {}
        doc = {
            "active_node_ids": sorted(active_node_ids),
            "command_id": command_id,
            "created_at": now,
            "dag": dag,
            "end_ids": end_ids or [],
            "flow_id": flow_id,
            "flow_resume_queue": get_settings().flow_resume_queue_name,
            "flow_run_id": run_id,
            "flow_task_id": flow_task_id,
            "locale": locale,
            "pending_resume": True,
            "protocol_version": protocol_version,
            "reply_queue": reply_queue,
            "run_id": run_id,
            "selected_outputs": selected_outputs,
            "start_ids": start_ids or [],
            "start_initialized": False,
            "status": "running",
            "trace_id": trace_id,
            "updated_at": now,
            "user_id": user_id,
            "user_selection": user_selection or {},
            "ws_id": ws_id,
        }
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id},
            {
                "$setOnInsert": doc,
                "$set": {
                    "pending_resume": True,
                    "selected_outputs": selected_outputs,
                    "updated_at": now,
                    "user_selection": user_selection or {},
                },
            },
            upsert=True,
        )
        return await cls.get_flow_run(database, run_id) or doc

    @classmethod
    async def get_flow_run(cls, database: Any, run_id: str) -> dict[str, Any] | None:
        return await database[cls.COLLECTION].find_one({"run_id": run_id})

    @classmethod
    async def mark_pending_resume(cls, database: Any, run_id: str, pending: bool) -> bool:
        result = await database[cls.COLLECTION].update_one(
            {"run_id": run_id},
            {"$set": {"pending_resume": pending, "updated_at": cls._now()}},
        )
        matched = getattr(result, "matched_count", None)
        if isinstance(matched, int):
            return matched == 1
        return bool(getattr(result, "modified_count", 0))

    @classmethod
    async def mark_terminal_event_outbox_recorded(
        cls,
        database: Any,
        run_id: str,
        event_id: str,
    ) -> None:
        now = cls._now()
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id},
            {
                "$set": {
                    "terminal_event_id": event_id,
                    "terminal_event_outbox_recorded": True,
                    "terminal_event_recorded_at": now,
                    "updated_at": now,
                }
            },
        )

    @classmethod
    async def mark_start_initialized(cls, database: Any, run_id: str) -> None:
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id},
            {"$set": {"start_initialized": True, "updated_at": cls._now()}},
        )

    @classmethod
    async def mark_completed(cls, database: Any, run_id: str) -> bool:
        result = await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "status": "running"},
            {
                "$set": {
                    "completed_at": cls._now(),
                    "pending_resume": False,
                    "status": "completed",
                    "updated_at": cls._now(),
                }
            },
        )
        return getattr(result, "matched_count", 0) == 1

    @classmethod
    async def request_cancel(
        cls,
        database: Any,
        *,
        run_id: str,
        command_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "status": "running"},
            {
                "$set": {
                    "cancel_command_id": command_id,
                    "cancel_requested": True,
                    "pending_resume": False,
                    "updated_at": now,
                }
            },
        )
        if getattr(result, "matched_count", 0) != 1:
            return await cls.get_flow_run(database, run_id)
        return await cls.get_flow_run(database, run_id)

    @classmethod
    async def mark_killed(
        cls,
        database: Any,
        *,
        run_id: str,
        command_id: str | None = None,
    ) -> bool:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "status": "running"},
            {
                "$set": {
                    "cancel_command_id": command_id,
                    "killed_at": now,
                    "pending_resume": False,
                    "status": "killed",
                    "updated_at": now,
                }
            },
        )
        return getattr(result, "matched_count", 0) == 1
