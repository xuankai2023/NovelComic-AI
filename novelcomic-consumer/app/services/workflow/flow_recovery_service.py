"""Scans that put an abandoned workflow hop back on its original chain.

Each method can be called without the maintenance scheduler. None of them
mints a new command id, event id, or result id.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from app.config import get_settings
from app.database.mq import V2_REPLY_QUEUE_NAME
from app.services.invocation.invocation_finalizer import InvocationFinalizer
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.opencreator_ai.errors import (
    OC_AI_SAFE_MESSAGES,
    OC_AI_WORKER_TIMEOUT_ERROR_CODE,
)
from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService

logger = logging.getLogger(__name__)

_KILLED_RUN_STATUSES = {"killed", "stopped"}
_TERMINAL_RUN_STATUSES = ["completed", "failed", "killed", "stopped", "success"]
_FINALIZE_STUCK_SECONDS = 60


class FlowRecoveryService:
    @classmethod
    async def redeliver_due_workflow_commands(
        cls,
        database: Any,
        *,
        redis_client: Any,
        limit: int | None = None,
    ) -> int:
        """Push expired inbox commands back onto ``run_flow`` with the same id."""

        from app.tasks.flow import RunFlowStream

        redelivered = 0
        scan_limit = limit or get_settings().flow_command_inbox_redelivery_limit
        for _ in range(scan_limit):
            command = await FlowCommandInboxService.claim_due_redelivery(database)
            if not command:
                break
            command_id = str(command.get("command_id") or command.get("_id") or "")
            redelivery_token = command.get("redelivery_lease_token")
            payload = command.get("redelivery_payload")
            if not command_id or not redelivery_token or not isinstance(payload, dict):
                logger.error(
                    "invalid inbox redelivery command_id=%s",
                    command_id or None,
                )
                if command_id and redelivery_token:
                    await FlowCommandInboxService.mark_redelivery_failed(
                        database,
                        command_id,
                        str(redelivery_token),
                        "missing redelivery payload or lease token",
                    )
                continue
            try:
                await RunFlowStream.aio_push(redis_client, **payload)
                await FlowCommandInboxService.mark_redelivery_enqueued(
                    database,
                    command_id,
                    str(redelivery_token),
                )
            except Exception as exc:
                await FlowCommandInboxService.mark_redelivery_failed(
                    database,
                    command_id,
                    str(redelivery_token),
                    str(exc),
                )
                logger.exception("workflow command redelivery failed command_id=%s", command_id)
                continue
            redelivered += 1
            logger.warning(
                "redelivered workflow command_id=%s attempts=%s",
                command_id,
                command.get("redelivery_attempts"),
            )
        return redelivered

    @classmethod
    async def mark_timed_out_invocations(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
    ) -> int:
        timeout_seconds = get_settings().webhook_callback_timeout_seconds
        cutoff = datetime.now(UTC) - timedelta(seconds=timeout_seconds)
        cursor = database[ModelInvocationService.COLLECTION].find(
            {
                "execution_mode": "webhook",
                "status": {"$in": ["submitting", "running"]},
                "updated_at": {"$lt": cutoff},
            }
        )
        count = 0
        async for invocation in cursor:
            if invocation.get("vendor") == "opencreator_ai":
                error = {
                    "code": OC_AI_WORKER_TIMEOUT_ERROR_CODE,
                    "error_code": OC_AI_WORKER_TIMEOUT_ERROR_CODE,
                    "message": OC_AI_SAFE_MESSAGES[OC_AI_WORKER_TIMEOUT_ERROR_CODE],
                    "origin": "oc-ai-worker",
                    "phase": "callback_timeout",
                }
            else:
                error = {"message": "webhook callback timeout"}
            await ModelInvocationService.complete(
                database,
                redis_client=redis_client,
                publisher=publisher,
                invocation_id=str(invocation["invocation_id"]),
                status="timeout",
                error=error,
            )
            count += 1
        if count:
            logger.warning("marked timed out invocations count=%s", count)
        return count

    @classmethod
    async def recover_orphaned_planned_nodes(
        cls,
        database: Any,
        *,
        run_id: str,
        stale_before: datetime,
    ) -> list[str]:
        """Requeue stale RUNNING nodes whose persisted plan is still missing invocations."""

        recovered_node_ids: list[str] = []
        for node in await FlowNodeStateService.list_nodes(database, run_id):
            if node.get("is_active") is False:
                continue
            if node.get("status") != "running":
                continue
            plans = node.get("execution_plans") or []
            plan_token = node.get("execution_plan_token")
            claim_token = node.get("execution_claim_token")
            started_at = node.get("started_at")
            if not plans or not plan_token or not claim_token or not started_at:
                continue
            if started_at > stale_before:
                continue

            expected_result_ids = node.get("expected_result_ids") or [
                plan.get("result_id")
                for plan in plans
                if isinstance(plan, dict) and plan.get("result_id")
            ]
            if not expected_result_ids:
                continue
            cursor = database[ModelInvocationService.COLLECTION].find(
                {
                    "node_id": node.get("node_id"),
                    "result_id": {"$in": expected_result_ids},
                    "run_id": run_id,
                }
            )
            existing_result_ids = {item.get("result_id") async for item in cursor}
            missing_result_ids = set(expected_result_ids) - existing_result_ids
            if not missing_result_ids:
                continue

            recovered = await FlowNodeStateService.requeue_orphaned_execution(
                database,
                run_id=run_id,
                node_id=str(node["node_id"]),
                execution_plan_token=str(plan_token),
                execution_claim_token=str(claim_token),
                stale_before=stale_before,
            )
            if not recovered:
                continue
            recovered_node_ids.append(str(node["node_id"]))
            logger.warning(
                "requeued orphaned execution run_id=%s node_id=%s missing_result_ids=%s",
                run_id,
                node.get("node_id"),
                sorted(str(item) for item in missing_result_ids),
            )
        return recovered_node_ids

    @classmethod
    async def recover_running_flows(cls, database: Any) -> list[str]:
        """Return run ids that can resume. This method does not call handle_resume."""

        settings = get_settings()
        queue_name = settings.flow_resume_queue_name
        cursor = database[FlowRunStateService.COLLECTION].find(
            {
                "status": "running",
                "$and": [
                    {
                        "$or": [
                            {"flow_resume_queue": queue_name},
                            {"flow_resume_queue": {"$exists": False}},
                            {"flow_resume_queue": None},
                        ]
                    },
                    {
                        "$or": [
                            {"protocol_version": {"$ne": 2}},
                            {"protocol_version": 2, "start_initialized": True},
                        ]
                    },
                ],
            }
        )
        run_ids: list[str] = []
        seen_run_ids: set[str] = set()
        stale_before = datetime.now(UTC) - timedelta(
            seconds=settings.flow_running_node_orphan_seconds
        )
        async for flow in cursor:
            if flow.get("protocol_version") == 2 and not flow.get("start_initialized"):
                logger.info(
                    "skip incomplete v2 bootstrap run_id=%s command_id=%s",
                    flow.get("run_id"),
                    flow.get("command_id"),
                )
                continue
            run_id = str(flow["run_id"])
            orphaned_node_ids: list[str] = []
            if flow.get("protocol_version") == 2:
                orphaned_node_ids = await cls.recover_orphaned_planned_nodes(
                    database,
                    run_id=run_id,
                    stale_before=stale_before,
                )
                if orphaned_node_ids:
                    await FlowRunStateService.mark_pending_resume(database, run_id, True)
            if flow.get("pending_resume"):
                run_ids.append(run_id)
                seen_run_ids.add(run_id)
                continue
            if orphaned_node_ids:
                run_ids.append(run_id)
                seen_run_ids.add(run_id)
                continue
            if await FlowNodeStateService.ready_nodes(database, run_id):
                pending_marked = await FlowRunStateService.mark_pending_resume(
                    database,
                    run_id,
                    True,
                )
                if pending_marked is not False and run_id not in seen_run_ids:
                    run_ids.append(run_id)
                    seen_run_ids.add(run_id)
                continue
            if await FlowNodeStateService.all_terminal(database, run_id):
                await FlowRunStateService.mark_pending_resume(database, run_id, True)
                if run_id not in seen_run_ids:
                    run_ids.append(run_id)
                    seen_run_ids.add(run_id)
        return run_ids

    @classmethod
    async def reconcile_terminal_flow_events(
        cls,
        database: Any,
        publisher: Any,
        *,
        limit: int | None = None,
    ) -> int:
        """Publish the missing run-level terminal event. Does not create node_status."""

        cursor = (
            database[FlowRunStateService.COLLECTION]
            .find(
                {
                    "protocol_version": 2,
                    "status": {"$in": _TERMINAL_RUN_STATUSES},
                    "terminal_event_outbox_recorded": {"$ne": True},
                }
            )
            .sort("updated_at", 1)
            .limit(limit or get_settings().flow_terminal_event_reconcile_limit)
        )
        reconciled = 0
        async for flow in cursor:
            run_id = flow.get("run_id")
            flow_task_id = flow.get("flow_task_id")
            if not run_id or not flow_task_id:
                continue
            status = str(flow.get("status") or "")
            event_type = "flow_killed" if status in _KILLED_RUN_STATUSES else "finish_flow"
            event_id = FlowEventPublishService.stable_event_id(event_type, run_id)
            await FlowEventPublishService.publish(
                database,
                publisher,
                queue_name=str(flow.get("reply_queue") or V2_REPLY_QUEUE_NAME),
                flow_task_id=str(flow_task_id),
                flow_run_id=str(flow.get("flow_run_id") or run_id),
                command_id=str(flow.get("command_id") or ""),
                event_type=event_type,
                event_id=event_id,
                payload={"run_id": run_id, "status": status},
                trace_id=flow.get("trace_id"),
            )
            await FlowRunStateService.mark_terminal_event_outbox_recorded(
                database,
                str(run_id),
                event_id,
            )
            reconciled += 1
        if reconciled:
            logger.warning("reconciled terminal flow events count=%s", reconciled)
        return reconciled

    @classmethod
    async def replay_pending_callbacks(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        limit: int = 100,
    ) -> int:
        """Replay pending callbacks through the same fast-path and Finalizer."""

        cursor = (
            database[ModelInvocationService.PENDING_CALLBACK_COLLECTION]
            .find({"status": "pending"})
            .limit(limit)
        )
        replayed_count = 0
        async for pending_callback in cursor:
            vendor = str(pending_callback.get("vendor") or "")
            payload = pending_callback.get("payload") or {}
            if not isinstance(payload, dict):
                payload = {}
            try:
                invocation = await ModelInvocationService.handle_callback_fast(
                    database,
                    vendor=vendor,
                    payload=payload,
                    idempotency_key=pending_callback.get("idempotency_key"),
                )
                if not invocation:
                    continue
                if invocation.get("_schedule_finalize"):
                    await InvocationFinalizer.run_finalize(
                        database,
                        redis_client=redis_client,
                        publisher=publisher,
                        invocation_id=str(invocation["invocation_id"]),
                    )
                await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].update_one(
                    {"_id": pending_callback["_id"]},
                    {
                        "$set": {
                            "invocation_id": invocation.get("invocation_id"),
                            "status": "replayed",
                            "updated_at": datetime.now(UTC),
                        }
                    },
                )
                replayed_count += 1
            except Exception as exc:
                await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].update_one(
                    {"_id": pending_callback["_id"]},
                    {
                        "$set": {
                            "error": str(exc),
                            "status": "failed",
                            "updated_at": datetime.now(UTC),
                        }
                    },
                )
                logger.exception(
                    "pending callback replay failed id=%s",
                    pending_callback.get("_id"),
                )
        return replayed_count

    @classmethod
    async def recover_stuck_finalize(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        limit: int | None = None,
    ) -> int:
        cutoff = datetime.now(UTC) - timedelta(seconds=_FINALIZE_STUCK_SECONDS)
        cursor = (
            database[ModelInvocationService.COLLECTION]
            .find(
                {
                    "$or": [
                        {
                            "finalize_status": {"$in": ["pending", "failed"]},
                            "updated_at": {"$lt": cutoff},
                        },
                        {
                            "finalize_started_at": {"$lt": cutoff},
                            "finalize_status": "running",
                        },
                    ]
                }
            )
            .limit(limit or get_settings().pending_deduction_reconcile_limit)
        )
        recovered_count = 0
        async for invocation in cursor:
            await InvocationFinalizer.run_finalize(
                database,
                redis_client=redis_client,
                publisher=publisher,
                invocation_id=str(invocation["invocation_id"]),
                force=invocation.get("finalize_status") == "running",
            )
            recovered_count += 1
        if recovered_count:
            logger.warning("recovered stuck finalize count=%s", recovered_count)
        return recovered_count

    @classmethod
    async def reconcile_pending_deductions(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        limit: int | None = None,
    ) -> int:
        reconcile_limit = limit or get_settings().pending_deduction_reconcile_limit
        cursor = (
            database[ModelInvocationService.COLLECTION]
            .find(
                {
                    "status": {"$in": ["success", "failed", "timeout"]},
                    "$or": [
                        {
                            "status": "success",
                            "$or": [
                                {"usage_status": {"$ne": "confirmed"}},
                                {"result_write_status": {"$ne": "done"}},
                                {"model_status_event_status": {"$ne": "sent"}},
                            ],
                        },
                        {
                            "status": {"$in": ["failed", "timeout"]},
                            "$or": [
                                {"rollback_status": {"$ne": "done"}},
                                {"result_write_status": {"$ne": "done"}},
                                {"model_status_event_status": {"$ne": "sent"}},
                            ],
                        },
                    ],
                }
            )
            .limit(reconcile_limit)
        )
        reconciled_count = 0
        async for invocation in cursor:
            deduction_id = (
                (invocation.get("metadata") or {}).get("deduction") or {}
            ).get("deduction_id")
            if invocation.get("status") == "success" and deduction_id:
                confirmed_usage = await database["usage_v2"].find_one(
                    {"deduction_id": deduction_id, "deduction_status": "deducted"}
                )
                if confirmed_usage:
                    await ModelInvocationService.mark_usage_confirmed_by_deduction_id(
                        database,
                        str(deduction_id),
                    )
            await ModelInvocationService.finalize_terminal_invocation(
                database,
                redis_client=redis_client,
                publisher=publisher,
                invocation=invocation,
            )
            reconciled_count += 1
        if reconciled_count:
            logger.warning("reconciled pending deductions count=%s", reconciled_count)
        return reconciled_count

    @classmethod
    async def replay_due_outbox_events(
        cls,
        database: Any,
        publisher: Any,
        *,
        limit: int | None = None,
    ) -> int:
        return await FlowEventPublishService.replay_due_events(
            database,
            publisher,
            limit=limit or get_settings().flow_event_outbox_replay_limit,
        )

    replay_failed_outbox_events = replay_due_outbox_events
