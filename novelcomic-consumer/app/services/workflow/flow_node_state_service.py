"""Workflow node state persistence and ready-node selection."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.database.mongo import FLOW_NODE_STATE
from app.services.workflow.flow_run_state_service import FlowRunStateService

TERMINAL_NODE_STATUSES = {"success", "failed", "stopped"}


class FlowNodeStateService:
    COLLECTION = FLOW_NODE_STATE

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _node_id(node: dict[str, Any]) -> str:
        return str(node.get("id") or node.get("node_id") or "")

    @classmethod
    def _graph_parts(
        cls,
        dag: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, list[str]], dict[str, list[str]]]:
        nodes = [node for node in (dag.get("nodes") or []) if cls._node_id(node)]
        node_ids = {cls._node_id(node) for node in nodes}
        predecessors: dict[str, list[str]] = defaultdict(list)
        successors: dict[str, list[str]] = defaultdict(list)
        for edge in dag.get("edges") or dag.get("links") or []:
            source = str(edge.get("source") or "")
            target = str(edge.get("target") or "")
            if source in node_ids and target in node_ids:
                successors[source].append(target)
                predecessors[target].append(source)
        return nodes, predecessors, successors

    @classmethod
    async def init_nodes(
        cls,
        database: Any,
        *,
        run_id: str,
        dag: dict[str, Any],
        start_ids: list[str] | None = None,
        end_ids: list[str] | None = None,
    ) -> None:
        nodes, predecessors, successors = cls._graph_parts(dag)
        active_node_ids = FlowRunStateService.active_node_ids(
            dag,
            start_ids=start_ids,
            end_ids=end_ids,
        )
        now = cls._now()
        for node in nodes:
            node_id = cls._node_id(node)
            await database[cls.COLLECTION].update_one(
                {"run_id": run_id, "node_id": node_id},
                {
                    "$setOnInsert": {
                        "attempt": 0,
                        "created_at": now,
                        "expected_result_ids": [],
                        "inputs": {},
                        "is_active": node_id in active_node_ids,
                        "node_data": node,
                        "node_id": node_id,
                        "node_type": node.get("type") or node.get("node_type"),
                        "outputs": {},
                        "predecessors": predecessors.get(node_id, []),
                        "run_id": run_id,
                        "status": "idle",
                        "successors": successors.get(node_id, []),
                    },
                    "$set": {"updated_at": now},
                },
                upsert=True,
            )

    @classmethod
    async def list_nodes(cls, database: Any, run_id: str) -> list[dict[str, Any]]:
        cursor = database[cls.COLLECTION].find({"run_id": run_id})
        return [node async for node in cursor]

    @classmethod
    async def ready_nodes(cls, database: Any, run_id: str) -> list[dict[str, Any]]:
        nodes = await cls.list_nodes(database, run_id)
        by_id = {node["node_id"]: node for node in nodes}
        ready: list[dict[str, Any]] = []
        for node in nodes:
            if node.get("is_active") is False:
                continue
            if node.get("status") not in {"idle", "ready", "queued"}:
                continue
            active_predecessors = [
                predecessor
                for predecessor in (node.get("predecessors") or [])
                if by_id.get(predecessor, {}).get("is_active") is not False
            ]
            if all(by_id.get(item, {}).get("status") == "success" for item in active_predecessors):
                ready.append(node)
        return ready

    @classmethod
    async def set_outputs(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        outputs: dict[str, Any],
        status: str = "success",
    ) -> None:
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "node_id": node_id},
            {
                "$set": {
                    "finished_at": cls._now(),
                    "outputs": outputs,
                    "status": status,
                    "updated_at": cls._now(),
                }
            },
        )

    @classmethod
    async def set_status(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        status: str,
        error_msg: str | None = None,
    ) -> None:
        update: dict[str, Any] = {"status": status, "updated_at": cls._now()}
        if status == "running":
            update["started_at"] = cls._now()
        if status in TERMINAL_NODE_STATUSES:
            update["finished_at"] = cls._now()
        if error_msg:
            update["error_msg"] = error_msg
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "node_id": node_id},
            {"$set": update},
        )

    @classmethod
    async def get_node(cls, database: Any, run_id: str, node_id: str) -> dict[str, Any] | None:
        return await database[cls.COLLECTION].find_one({"run_id": run_id, "node_id": node_id})

    @classmethod
    async def transition_status(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        from_statuses: list[str],
        status: str,
        error_msg: str | None = None,
    ) -> bool:
        update: dict[str, Any] = {"status": status, "updated_at": cls._now()}
        if status == "running":
            update["started_at"] = cls._now()
        if status in TERMINAL_NODE_STATUSES or status == "select":
            update["finished_at"] = cls._now()
        if error_msg:
            update["error_msg"] = error_msg
        result = await database[cls.COLLECTION].update_one(
            {
                "run_id": run_id,
                "node_id": node_id,
                "status": {"$in": from_statuses},
            },
            {"$set": update},
        )
        return getattr(result, "matched_count", 0) == 1

    @classmethod
    async def set_expected_result(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        result_id: str,
        execution_plan_token: str,
        execution_plans: list[dict[str, Any]] | None = None,
        expected_result_ids: list[str] | None = None,
    ) -> None:
        resolved_ids = (
            [str(item) for item in expected_result_ids if item]
            if expected_result_ids
            else [result_id]
        )
        update: dict[str, Any] = {
            "execution_plan_token": execution_plan_token,
            "expected_result_ids": resolved_ids,
            "updated_at": cls._now(),
        }
        if execution_plans is not None:
            update["execution_plans"] = execution_plans
        await database[cls.COLLECTION].update_one(
            {"run_id": run_id, "node_id": node_id},
            {"$set": update},
        )

    @classmethod
    async def claim_planned_execution(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        execution_plan_token: str,
    ) -> str | None:
        claim_token = uuid4().hex
        result = await database[cls.COLLECTION].update_one(
            {
                "execution_plan_token": execution_plan_token,
                "node_id": node_id,
                "run_id": run_id,
                "status": {"$in": ["idle", "ready", "queued"]},
            },
            {
                "$set": {
                    "execution_claim_token": claim_token,
                    "execution_claimed_at": cls._now(),
                    "started_at": cls._now(),
                    "status": "running",
                    "updated_at": cls._now(),
                }
            },
        )
        return claim_token if getattr(result, "matched_count", 0) == 1 else None

    @classmethod
    async def requeue_orphaned_execution(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        execution_plan_token: str,
        execution_claim_token: str,
        stale_before: datetime,
    ) -> bool:
        """CAS a stale RUNNING planned node back to queued.

        The old claim token is cleared. ``execution_plans`` and
        ``expected_result_ids`` stay so the next resume submits the same result ids.
        """

        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {
                "execution_claim_token": execution_claim_token,
                "execution_plan_token": execution_plan_token,
                "node_id": node_id,
                "run_id": run_id,
                "started_at": {"$lte": stale_before},
                "status": "running",
            },
            {
                "$inc": {"execution_recovery_attempts": 1},
                "$set": {
                    "orphan_recovered_at": now,
                    "status": "queued",
                    "updated_at": now,
                },
                "$unset": {
                    "execution_claim_token": "",
                    "execution_claimed_at": "",
                },
            },
        )
        matched = getattr(result, "matched_count", 0)
        modified = getattr(result, "modified_count", matched)
        return bool(matched or modified)

    @classmethod
    async def execution_claim_is_current(
        cls,
        database: Any,
        *,
        run_id: str,
        node_id: str,
        execution_claim_token: str,
    ) -> bool:
        node = await database[cls.COLLECTION].find_one(
            {
                "execution_claim_token": execution_claim_token,
                "node_id": node_id,
                "run_id": run_id,
                "status": "running",
            }
        )
        return node is not None

    @classmethod
    async def stop_descendants(cls, database: Any, run_id: str, node_id: str) -> list[str]:
        nodes = await cls.list_nodes(database, run_id)
        by_id = {node["node_id"]: node for node in nodes}
        stopped: list[str] = []
        queue: deque[str] = deque(by_id.get(node_id, {}).get("successors") or [])
        seen: set[str] = set()
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            node = by_id.get(current)
            if node is None or node.get("is_active") is False:
                continue
            if node.get("status") not in TERMINAL_NODE_STATUSES:
                await cls.set_status(database, run_id=run_id, node_id=current, status="stopped")
                stopped.append(current)
            queue.extend(node.get("successors") or [])
        return stopped

    @classmethod
    def _selection_by_node(cls, user_selection: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(user_selection, dict):
            return {}

        by_node: dict[str, Any] = {}
        for key, value in user_selection.items():
            if isinstance(value, list):
                for item in value:
                    if not isinstance(item, dict):
                        continue
                    node_id = str(item.get("node_id") or "")
                    if node_id:
                        by_node[node_id] = item
                continue
            by_node[str(key)] = value
        return by_node

    @classmethod
    async def seed_user_selection_outputs(
        cls,
        database: Any,
        *,
        run_id: str,
        user_selection: dict[str, Any] | None,
    ) -> int:
        """Write upstream selections onto inactive nodes without changing status."""

        by_node = cls._selection_by_node(user_selection)
        if not by_node:
            return 0

        written = 0
        now = cls._now()
        for node_id, selected_outputs in by_node.items():
            existing = await cls.get_node(database, run_id, node_id)
            if existing is None or existing.get("is_active") is True:
                continue
            result = await database[cls.COLLECTION].update_one(
                {"run_id": run_id, "node_id": node_id},
                {"$set": {"selected_outputs": selected_outputs, "updated_at": now}},
            )
            if getattr(result, "matched_count", 0) == 1:
                written += 1
        return written

    @classmethod
    async def apply_user_selection_for_continue(
        cls,
        database: Any,
        *,
        run_id: str,
        user_selection: dict[str, Any] | None,
        command_id: str | None = None,
    ) -> dict[str, int]:
        by_node = cls._selection_by_node(user_selection)
        if not by_node:
            return {
                "selection_written": 0,
                "restored_select_to_success": 0,
                "already_applied_select_to_success": 0,
            }

        now = cls._now()
        await database[FlowRunStateService.COLLECTION].update_one(
            {"run_id": run_id, "status": "running"},
            {
                "$set": {
                    "command_id": command_id,
                    "selected_outputs": by_node,
                    "updated_at": now,
                    "user_selection": user_selection or {},
                }
            },
        )

        selection_written = 0
        restored = 0
        already_applied = 0
        for node_id, selected_outputs in by_node.items():
            node = await cls.get_node(database, run_id, node_id)
            if node is None:
                continue
            update = {
                "selected_outputs": selected_outputs,
                "updated_at": now,
            }
            if node.get("status") == "select":
                update["status"] = "success"
                update["finished_at"] = now
                if command_id:
                    update["continue_command_id"] = command_id
                result = await database[cls.COLLECTION].update_one(
                    {"run_id": run_id, "node_id": node_id, "status": "select"},
                    {"$set": update},
                )
                if getattr(result, "matched_count", 0) == 1:
                    restored += 1
                    selection_written += 1
                continue
            if (
                command_id
                and node.get("status") == "success"
                and node.get("continue_command_id") == command_id
            ):
                already_applied += 1
            result = await database[cls.COLLECTION].update_one(
                {"run_id": run_id, "node_id": node_id, "status": node.get("status")},
                {"$set": update},
            )
            if getattr(result, "matched_count", 0) == 1:
                selection_written += 1
        return {
            "selection_written": selection_written,
            "restored_select_to_success": restored,
            "already_applied_select_to_success": already_applied,
        }

    @classmethod
    async def all_terminal(cls, database: Any, run_id: str) -> bool:
        nodes = await cls.list_nodes(database, run_id)
        active_nodes = [node for node in nodes if node.get("is_active") is not False]
        return bool(active_nodes) and all(
            node.get("status") in TERMINAL_NODE_STATUSES for node in active_nodes
        )
