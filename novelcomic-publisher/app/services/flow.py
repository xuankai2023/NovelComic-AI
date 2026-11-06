"""Workflow project persistence and run dispatch helpers."""

from datetime import UTC, datetime
from time import time
from typing import Any
from uuid import uuid4

from app.common.context.request_context import RequestContext
from app.dao.flow import FlowDao
from app.schemas.workflow_project import (
    SaveWorkflowProjectRequest,
    UpdateWorkflowProjectDetailsRequest,
    UpdateWorkflowProjectRequest,
    WorkflowProjectResponse,
)
from app.tasks.flow import FlowTask
from app.utils.id_utils import generate_trace_id

ASSEMBLE_NODE_TYPE = "assembleNow"
NON_EXECUTABLE_NODE_TYPES = {ASSEMBLE_NODE_TYPE, "groupNode", "stickyNodesNode"}


class FlowService:
    @staticmethod
    def filter_non_executable_nodes_with_edges(
        *,
        node_list: list[dict[str, Any]],
        edge_list: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        removed_node_ids = {
            node.get("id")
            for node in node_list
            if isinstance(node, dict) and node.get("type") in NON_EXECUTABLE_NODE_TYPES
        }
        nodes = [node for node in node_list if node.get("id") not in removed_node_ids]
        edges = [
            edge
            for edge in edge_list
            if edge.get("source") not in removed_node_ids and edge.get("target") not in removed_node_ids
        ]
        return nodes, edges

    @staticmethod
    def _build_dag(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
        node_ids = {node.get("id") for node in nodes if isinstance(node.get("id"), str)}
        indegree = {node_id: 0 for node_id in node_ids}
        adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
        filtered_edges: list[dict[str, Any]] = []

        for edge in edges:
            source = edge.get("source")
            target = edge.get("target")
            if source not in node_ids or target not in node_ids:
                continue
            filtered_edges.append(edge)
            adjacency[source].append(target)
            indegree[target] += 1

        ready = [node_id for node_id, degree in indegree.items() if degree == 0]
        visited = 0
        while ready:
            node_id = ready.pop()
            visited += 1
            for target in adjacency[node_id]:
                indegree[target] -= 1
                if indegree[target] == 0:
                    ready.append(target)
        if visited != len(node_ids):
            raise ValueError("workflow graph must not contain a cycle")

        return {
            "directed": True,
            "multigraph": False,
            "graph": {},
            "nodes": nodes,
            "edges": filtered_edges,
        }

    @classmethod
    async def enqueue_flow_task(
        cls,
        *,
        redis_client: Any,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        reply_channel_id: str,
        flow_task_id: str,
        flow_id: str | None = None,
        flow_run_type: str = "start",
        flow_run_id: str = "",
        user_selection: Any = None,
        start_ids: list[str] | None = None,
        end_ids: list[str] | None = None,
        user_id: str | None = None,
        locale: str | None = None,
        reply_queue_name: str | None = None,
        trace_id: str | None = None,
        command_id: str | None = None,
        protocol_version: int | None = None,
    ) -> dict[str, str]:
        nodes, edges = cls.filter_non_executable_nodes_with_edges(
            node_list=nodes,
            edge_list=edges,
        )
        dag = cls._build_dag(nodes, edges)
        trace_id = trace_id or RequestContext.get_trace_id()
        if not trace_id or trace_id == "-":
            trace_id = generate_trace_id()
        sentry_trace = ""
        sentry_baggage = ""
        try:
            import sentry_sdk

            sentry_trace = sentry_sdk.get_traceparent() or ""
            baggage = sentry_sdk.get_baggage()
            sentry_baggage = baggage.serialize() if baggage else ""
        except Exception:
            sentry_trace = ""
            sentry_baggage = ""
        publish_payload = {
            "command_id": command_id,
            "dag": dag,
            "end_ids": end_ids or [],
            "flow_id": flow_id,
            "flow_run_id": flow_run_id,
            "flow_run_type": flow_run_type,
            "flow_task_id": flow_task_id,
            "locale": locale,
            "protocol_version": protocol_version,
            "publish_timestamp": time(),
            "reply_channel_id": reply_channel_id,
            "reply_queue": reply_queue_name,
            "sentry_baggage": sentry_baggage,
            "sentry_trace": sentry_trace,
            "start_ids": start_ids or [],
            "trace_id": trace_id,
            "user_id": user_id or "",
            "user_selection": user_selection or {},
            "ws_id": reply_channel_id,
        }
        await FlowTask.run_flow.publish(
            redis_client=redis_client,
            payload=publish_payload,
            task_id=flow_task_id,
        )
        return {
            "flow_task_id": flow_task_id,
            "flow_run_id": flow_run_id,
            "trace_id": trace_id,
        }

    @classmethod
    async def save_workflow_project(
        cls,
        *,
        database: Any,
        req: SaveWorkflowProjectRequest,
        user_id: str,
    ) -> WorkflowProjectResponse:
        flow_id = uuid4().hex
        now = datetime.now(UTC)
        project = {
            "flow_id": flow_id,
            "user_id": user_id,
            "nodes": req.nodes,
            "edges": req.edges,
            "details": {
                "flow_id": flow_id,
                "project_name": req.project_name,
                "created_at": now,
                "updated_at": now,
                "time_zone": None,
                "snapshot": None,
                "app_mode_config": None,
            },
            "allow_reshare": req.allow_reshare,
            "parent_flow_id": req.parent_flow_id,
            "created_at": now,
            "updated_at": now,
            "time_zone": None,
            "last_view_time": None,
        }
        await FlowDao.insert_workflow_project(database, project)
        return WorkflowProjectResponse(**project)

    @classmethod
    async def get_workflow_project(
        cls,
        *,
        database: Any,
        flow_id: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        return await FlowDao.get_workflow_project(database, flow_id, user_id)

    @classmethod
    async def update_workflow_project_last_view_time(
        cls,
        *,
        database: Any,
        flow_id: str,
        user_id: str,
    ) -> datetime:
        last_view_time = datetime.now(UTC)
        await FlowDao.update_workflow_project_last_view_time(
            database,
            flow_id=flow_id,
            user_id=user_id,
            last_view_time=last_view_time,
        )
        return last_view_time

    @classmethod
    async def update_workflow_project_without_response(
        cls,
        *,
        database: Any,
        req: UpdateWorkflowProjectRequest,
        user_id: str,
    ) -> None:
        now = datetime.now(UTC)
        await FlowDao.update_workflow_project(
            database,
            flow_id=req.flow_id,
            user_id=user_id,
            updates={
                "nodes": req.nodes,
                "edges": req.edges,
                "updated_at": now,
                "details.updated_at": now,
            },
        )

    @classmethod
    async def update_workflow_project_details_without_response(
        cls,
        *,
        database: Any,
        req: UpdateWorkflowProjectDetailsRequest,
        user_id: str,
    ) -> None:
        if req.project_name is None and req.snapshot_url is None and req.snapshot_thumbnail_url is None:
            return
        now = datetime.now(UTC)
        updates: dict[str, Any] = {"details.updated_at": now}
        if req.project_name is not None:
            updates["details.project_name"] = req.project_name
        if req.snapshot_url is not None or req.snapshot_thumbnail_url is not None:
            updates["details.snapshot"] = {
                "snapshot_url": req.snapshot_url or "",
                "snapshot_thumbnail_url": req.snapshot_thumbnail_url or req.snapshot_url or "",
            }
        await FlowDao.update_workflow_project(
            database,
            flow_id=req.flow_id,
            user_id=user_id,
            updates=updates,
        )
