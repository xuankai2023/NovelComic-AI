"""Advance ready workflow nodes and submit model nodes to AI service."""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from app.config import get_settings
from app.database.mq import V2_REPLY_QUEUE_NAME
from app.services.invocation.model_invocation_planner import ModelInvocationPlanner
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService

logger = logging.getLogger(__name__)

BASIC_INPUT_NODE_TYPES = {"textInput", "imageInput", "videoInput", "audioInput"}
TERMINAL_NODE_STATUSES = {"success", "failed", "stopped"}
FLOW_RESUME_LOCK_PREFIX = "opencreator:flow_resume_lock:"


def _decode_redis_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


class FlowResumeTask:
    @staticmethod
    async def handle_resume(
        database: Any,
        *,
        redis_client: Any | None = None,
        run_id: str,
        publisher: Any,
        reason: str | None = None,
        trace_id: str | None = None,
    ) -> None:
        if redis_client is None:
            logger.info("resume skipped without redis lock run_id=%s reason=%s", run_id, reason)
            return

        token = uuid4().hex
        lock_key = f"{FLOW_RESUME_LOCK_PREFIX}{run_id}"
        locked = await redis_client.set(
            lock_key,
            token,
            ex=get_settings().flow_resume_lock_ttl_seconds,
            nx=True,
        )
        if not locked:
            logger.info(
                "resume locked elsewhere run_id=%s reason=%s trace_id=%s",
                run_id,
                reason,
                trace_id,
            )
            return
        try:
            await FlowResumeTask._resume_once(
                database,
                redis_client=redis_client,
                run_id=run_id,
                publisher=publisher,
            )
        finally:
            current_token = _decode_redis_value(await redis_client.get(lock_key))
            if current_token == token:
                await redis_client.delete(lock_key)

    @staticmethod
    async def _resume_once(
        database: Any,
        *,
        redis_client: Any | None = None,
        run_id: str,
        publisher: Any,
    ) -> None:
        flow = await FlowRunStateService.get_flow_run(database, run_id)
        if flow is None or flow.get("status") != "running":
            return

        await FlowRunStateService.mark_pending_resume(database, run_id, False)
        processed: set[str] = set()
        while True:
            ready_nodes = [
                node
                for node in await FlowNodeStateService.ready_nodes(database, run_id)
                if node.get("node_id") not in processed
            ]
            if not ready_nodes:
                break
            for node in ready_nodes:
                processed.add(str(node.get("node_id")))
                await FlowResumeTask._process_ready_node(
                    database,
                    redis_client=redis_client,
                    publisher=publisher,
                    flow=flow,
                    node=node,
                )

        if await FlowNodeStateService.all_terminal(database, run_id):
            completed = await FlowRunStateService.mark_completed(database, run_id)
            if completed:
                await FlowResumeTask._publish_finish_flow(database, publisher, flow, "completed")

    @staticmethod
    async def _process_ready_node(
        database: Any,
        *,
        redis_client: Any | None = None,
        publisher: Any,
        flow: dict[str, Any],
        node: dict[str, Any],
    ) -> None:
        node_id = str(node["node_id"])
        node_type = str(node.get("node_type") or "")
        inputs = await FlowResumeTask._collect_inputs(database, flow["run_id"], node)

        if node_type in BASIC_INPUT_NODE_TYPES:
            node_data = node.get("node_data") or {}
            outputs = {"node_data": node_data.get("data") or {}, "inputs": inputs}
            await FlowNodeStateService.set_status(
                database,
                run_id=flow["run_id"],
                node_id=node_id,
                status="running",
            )
            await FlowResumeTask._publish_node_status(database, publisher, flow, node_id, "running")
            await FlowNodeStateService.set_outputs(
                database,
                run_id=flow["run_id"],
                node_id=node_id,
                outputs=outputs,
                status="success",
            )
            await FlowResumeTask._publish_node_status(database, publisher, flow, node_id, "success")
            return

        plan = await ModelInvocationPlanner.plan_node(
            database,
            run_id=flow["run_id"],
            node=node,
            inputs=inputs,
        )
        execution_claim_token = await FlowNodeStateService.claim_planned_execution(
            database,
            run_id=flow["run_id"],
            node_id=node_id,
            execution_plan_token=plan.execution_plan_token,
        )
        if not execution_claim_token:
            return
        await FlowResumeTask._publish_node_status(database, publisher, flow, node_id, "running")
        await ModelInvocationService.submit_planned_node(
            database,
            redis_client=redis_client,
            flow=flow,
            node=node,
            plan=plan,
            execution_claim_token=execution_claim_token,
            inputs=inputs,
        )

    @staticmethod
    async def _publish_node_status(
        database: Any,
        publisher: Any,
        flow: dict[str, Any],
        node_id: str,
        status: str,
    ) -> None:
        await FlowEventPublishService.publish(
            database,
            publisher,
            queue_name=str(flow.get("reply_queue") or V2_REPLY_QUEUE_NAME),
            flow_task_id=str(flow.get("flow_task_id") or ""),
            flow_run_id=str(flow.get("flow_run_id") or flow.get("run_id") or ""),
            command_id=str(flow.get("command_id") or ""),
            event_type="node_status",
            event_id=FlowEventPublishService.stable_event_id(
                "node_status", flow.get("run_id"), node_id, status
            ),
            payload={"node_id": node_id, "run_id": flow.get("run_id"), "status": status},
        )

    @staticmethod
    async def _publish_finish_flow(
        database: Any,
        publisher: Any,
        flow: dict[str, Any],
        status: str,
    ) -> None:
        await FlowEventPublishService.publish(
            database,
            publisher,
            queue_name=str(flow.get("reply_queue") or V2_REPLY_QUEUE_NAME),
            flow_task_id=str(flow.get("flow_task_id") or ""),
            flow_run_id=str(flow.get("flow_run_id") or flow.get("run_id") or ""),
            command_id=str(flow.get("command_id") or ""),
            event_type="finish_flow",
            event_id=FlowEventPublishService.stable_event_id("finish_flow", flow.get("run_id")),
            payload={"run_id": flow.get("run_id"), "status": status},
        )

    @staticmethod
    async def _stop_flow_for_kill(
        database: Any,
        *,
        publisher: Any,
        flow: dict[str, Any],
    ) -> None:
        run_id = str(flow["run_id"])
        nodes = await FlowNodeStateService.list_nodes(database, run_id)
        for node in nodes:
            if node.get("is_active") is False or node.get("status") in TERMINAL_NODE_STATUSES:
                continue
            node_id = str(node["node_id"])
            await FlowNodeStateService.set_status(
                database,
                run_id=run_id,
                node_id=node_id,
                status="stopped",
            )
            await FlowResumeTask._publish_node_status(
                database, publisher, flow, node_id, "stopped"
            )

        killed = await FlowRunStateService.mark_killed(
            database,
            run_id=run_id,
            command_id=str(flow.get("cancel_command_id") or flow.get("command_id") or ""),
        )
        if not killed:
            return
        await FlowEventPublishService.publish(
            database,
            publisher,
            queue_name=str(flow.get("reply_queue") or V2_REPLY_QUEUE_NAME),
            flow_task_id=str(flow.get("flow_task_id") or ""),
            flow_run_id=str(flow.get("flow_run_id") or flow.get("run_id") or ""),
            command_id=str(flow.get("cancel_command_id") or flow.get("command_id") or ""),
            event_type="flow_killed",
            event_id=FlowEventPublishService.stable_event_id("flow_killed", flow.get("run_id")),
            payload={"run_id": flow.get("run_id"), "status": "killed"},
        )

    @staticmethod
    async def _collect_inputs(database: Any, run_id: str, node: dict[str, Any]) -> dict[str, Any]:
        inputs: dict[str, Any] = {}
        flow = await FlowRunStateService.get_flow_run(database, run_id)
        selected_outputs = flow.get("selected_outputs") if isinstance(flow, dict) else {}
        selected_outputs = selected_outputs if isinstance(selected_outputs, dict) else {}
        for predecessor_id in node.get("predecessors") or []:
            predecessor = await database[FlowNodeStateService.COLLECTION].find_one(
                {"run_id": run_id, "node_id": predecessor_id}
            )
            if predecessor and predecessor.get("selected_outputs"):
                inputs[predecessor_id] = predecessor.get("selected_outputs")
                continue
            if predecessor_id in selected_outputs and selected_outputs[predecessor_id]:
                inputs[predecessor_id] = selected_outputs[predecessor_id]
                continue
            if predecessor and predecessor.get("outputs"):
                inputs[predecessor_id] = predecessor.get("outputs") or {}
        return inputs
