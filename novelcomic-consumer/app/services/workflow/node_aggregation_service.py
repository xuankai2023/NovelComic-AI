"""Aggregate model callback results into durable node state."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.database.mq import V2_REPLY_QUEUE_NAME
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService

TERMINAL_INVOCATION_STATUSES = {"success", "failed", "timeout"}


@dataclass(frozen=True)
class NodeAggregationDecision:
    status: str
    reason: str = ""

    @staticmethod
    def _successful_output_count(invocations: list[dict[str, Any]]) -> int:
        count = 0
        for item in invocations:
            if item.get("status") != "success":
                continue
            result = item.get("result") or {}
            formatted_output = result.get("formatted_output")
            count += len(formatted_output) if isinstance(formatted_output, list) else 1
        return count

    @classmethod
    def from_invocations(
        cls,
        *,
        expected_result_ids: list[str],
        invocations: list[dict[str, Any]],
        has_successors: bool,
        is_end_node: bool = False,
    ) -> NodeAggregationDecision:
        by_result_id: dict[str, list[dict[str, Any]]] = {}
        for item in invocations:
            by_result_id.setdefault(str(item.get("result_id") or ""), []).append(item)

        for result_id in expected_result_ids:
            attempts = by_result_id.get(str(result_id)) or []
            if not attempts:
                return cls("waiting", "missing_result")
            if any(item.get("status") in {"submitting", "running", "queued"} for item in attempts):
                return cls("waiting", "in_flight")
            if not any(item.get("status") in TERMINAL_INVOCATION_STATUSES for item in attempts):
                return cls("waiting", "not_terminal")

        successful_result_ids = {
            item.get("result_id") for item in invocations if item.get("status") == "success"
        }
        if not successful_result_ids:
            return cls("failed", "all_failed")

        if (
            (len(expected_result_ids) > 1 or cls._successful_output_count(invocations) > 1)
            and has_successors
            and not is_end_node
        ):
            return cls("select", "multiple_candidates")
        return cls("success", "success")


class NodeAggregationService:
    @classmethod
    async def aggregate_invocation(
        cls,
        database: Any,
        *,
        redis_client: Any | None = None,
        publisher: Any,
        invocation: dict[str, Any],
    ) -> None:
        run_id = str(invocation["run_id"])
        node_id = str(invocation["node_id"])
        flow = await FlowRunStateService.get_flow_run(database, run_id)
        node = await FlowNodeStateService.get_node(database, run_id, node_id)
        if flow is None or node is None:
            return

        expected_result_ids = [
            str(item) for item in (node.get("expected_result_ids") or [invocation["result_id"]])
        ]
        cursor = database[ModelInvocationService.COLLECTION].find(
            {"run_id": run_id, "node_id": node_id, "result_id": {"$in": expected_result_ids}}
        )
        invocations = [item async for item in cursor]
        decision = NodeAggregationDecision.from_invocations(
            expected_result_ids=expected_result_ids,
            invocations=invocations,
            has_successors=bool(node.get("successors")),
            is_end_node=node_id in set(flow.get("end_ids") or []),
        )
        if decision.status == "waiting":
            return

        if decision.status == "failed":
            await FlowNodeStateService.transition_status(
                database,
                run_id=run_id,
                node_id=node_id,
                from_statuses=["running", "queued"],
                status="failed",
                error_msg="all model invocations failed",
            )
            stopped_node_ids = await FlowNodeStateService.stop_descendants(
                database, run_id, node_id
            )
            await cls._publish_node_status(database, publisher, flow, node_id, "failed")
            for stopped_node_id in stopped_node_ids:
                await cls._publish_node_status(
                    database, publisher, flow, stopped_node_id, "stopped"
                )
            await cls._enqueue_resume(
                database,
                redis_client=redis_client,
                publisher=publisher,
                run_id=run_id,
                reason="node_failed",
            )
            return

        await FlowNodeStateService.transition_status(
            database,
            run_id=run_id,
            node_id=node_id,
            from_statuses=["running", "queued"],
            status=decision.status,
        )
        await cls._publish_node_status(database, publisher, flow, node_id, decision.status)
        if decision.status == "success":
            await cls._enqueue_resume(
                database,
                redis_client=redis_client,
                publisher=publisher,
                run_id=run_id,
                reason="node_success",
            )

    @staticmethod
    async def _publish_node_status(
        database: Any,
        publisher: Any,
        flow: dict[str, Any],
        node_id: str,
        status: str,
    ) -> None:
        node = await FlowNodeStateService.get_node(database, str(flow["run_id"]), node_id)
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
            payload={
                "node_id": node_id,
                "outputs": (node or {}).get("outputs") or {},
                "run_id": flow.get("run_id"),
                "status": status,
            },
        )

    @staticmethod
    async def _enqueue_resume(
        database: Any,
        *,
        redis_client: Any | None = None,
        publisher: Any,
        run_id: str,
        reason: str,
    ) -> None:
        from app.tasks.flow_resume import FlowResumeTask

        await FlowRunStateService.mark_pending_resume(database, run_id, True)
        await FlowResumeTask.handle_resume(
            database,
            redis_client=redis_client,
            run_id=run_id,
            reason=reason,
            publisher=publisher,
        )
