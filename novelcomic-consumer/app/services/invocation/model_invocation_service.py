"""Submit planned workflow model invocations to the AI task service."""

from __future__ import annotations

from typing import Any

from pymongo import ReturnDocument

from app.config import get_settings
from app.model_gateway.providers.opencreator_ai import (
    ModelProviderRequest,
    OpenCreatorAIProvider,
)
from app.services.invocation.invocation_billing_service import InvocationBillingService
from app.services.invocation.model_invocation_planner import ModelInvocationPlan
from app.services.opencreator_ai.task_client import (
    OpenCreatorAISubmitError,
    OpenCreatorAITaskClient,
)
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.utils.trace_context import set_trace_id

TERMINAL_INVOCATION_STATUSES = {"success", "failed", "timeout"}


class ModelInvocationService:
    COLLECTION = "model_invocations"
    PENDING_CALLBACK_COLLECTION = "pending_model_callback"
    VENDOR = "opencreator_ai"

    @staticmethod
    def _node_config(node: dict[str, Any]) -> dict[str, Any]:
        node_data = node.get("node_data") or {}
        data = node_data.get("data") if isinstance(node_data.get("data"), dict) else {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _model_id(plan: ModelInvocationPlan, node: dict[str, Any]) -> str:
        if plan.execution_plans:
            model_id = plan.execution_plans[0].get("model_id")
            if model_id:
                return str(model_id)
        node_config = ModelInvocationService._node_config(node)
        selected_models = node_config.get("selectedModels")
        if isinstance(selected_models, list) and selected_models:
            return str(selected_models[0])
        return str(node_config.get("model_id") or node_config.get("modelId") or "default")

    @staticmethod
    def _webhook_url(flow: dict[str, Any], public_base_url: str) -> str:
        webhook_url = flow.get("webhook_url") or flow.get("callback_url")
        if webhook_url:
            return str(webhook_url)
        return f"{public_base_url.rstrip('/')}/callbacks/models/opencreator_ai"

    @staticmethod
    def _model_options(node_config: dict[str, Any]) -> dict[str, Any]:
        for key in ("model_options", "modelOptions", "modelConfigs"):
            value = node_config.get(key)
            if isinstance(value, dict):
                return value
        return {}

    @classmethod
    async def submit_planned_node(
        cls,
        database: Any,
        *,
        redis_client: Any | None = None,
        flow: dict[str, Any],
        node: dict[str, Any],
        plan: ModelInvocationPlan,
        execution_claim_token: str,
        inputs: dict[str, Any],
    ) -> None:
        if not await FlowNodeStateService.execution_claim_is_current(
            database,
            run_id=flow["run_id"],
            node_id=node["node_id"],
            execution_claim_token=execution_claim_token,
        ):
            return

        node_data = node.get("node_data") or {}
        settings = get_settings()
        trace_id = flow.get("trace_id")
        node_config = cls._node_config(node)
        execution_plans = (
            plan.execution_plans
            if isinstance(plan.execution_plans, list) and plan.execution_plans
            else [{"model_id": cls._model_id(plan, node), "result_id": plan.result_id}]
        )
        provider = OpenCreatorAIProvider(
            OpenCreatorAITaskClient(
                base_url=settings.oc_api_url,
                timeout_seconds=settings.ai_submit_timeout_seconds,
            )
        )
        for exec_plan in execution_plans:
            plan_result_id = str(
                (exec_plan.get("result_id") if isinstance(exec_plan, dict) else None)
                or plan.result_id
            )
            plan_model_id = str(
                (exec_plan.get("model_id") if isinstance(exec_plan, dict) else None)
                or cls._model_id(plan, node)
            )
            idempotency_key = plan_result_id
            client_context = {
                "flow_id": flow.get("flow_id"),
                "flow_run_id": flow.get("flow_run_id") or flow.get("run_id"),
                "flow_task_id": flow.get("flow_task_id"),
                "node_id": node["node_id"],
                "node_type": node.get("node_type"),
                "result_id": plan_result_id,
                "run_id": flow["run_id"],
                "execution_plan_token": plan.execution_plan_token,
            }
            request = ModelProviderRequest(
                model_id=plan_model_id,
                config_name=str(node.get("node_type") or ""),
                arguments={
                    "execution_plans": plan.execution_plans,
                    "inputs": inputs,
                    "node": node_data,
                },
                model_options=cls._model_options(node_config),
                webhook_url=cls._webhook_url(flow, settings.consumer_public_base_url),
                trace_id=str(trace_id) if trace_id else None,
                idempotency_key=idempotency_key,
                locale=flow.get("locale"),
                client_context=client_context,
            )
            deduction = await InvocationBillingService.reserve_for_node(
                database,
                redis_client,
                user_id=str(flow.get("user_id") or ""),
                model_id=request.model_id,
                node=node,
                arguments=dict(request.arguments or {}),
            )
            now = FlowRunStateService._now()
            invocation_id = plan_result_id
            await database[cls.COLLECTION].update_one(
                {"invocation_id": invocation_id},
                {
                    "$setOnInsert": {
                        "client_context": client_context,
                        "created_at": now,
                        "execution_plan_token": plan.execution_plan_token,
                        "flow_run_id": flow.get("flow_run_id") or flow.get("run_id"),
                        "flow_task_id": flow.get("flow_task_id"),
                        "idempotency_key": idempotency_key,
                        "invocation_id": invocation_id,
                        "metadata": {"deduction": deduction} if deduction else {},
                        "model_id": request.model_id,
                        "node_id": node["node_id"],
                        "execution_mode": "webhook",
                        "result_id": plan_result_id,
                        "run_id": flow["run_id"],
                        "status": "submitting",
                        "trace_id": trace_id,
                        "user_id": flow.get("user_id") or "",
                        "vendor": cls.VENDOR,
                    },
                    "$set": {"updated_at": now},
                },
                upsert=True,
            )
            try:
                task = await provider.submit(request)
            except OpenCreatorAISubmitError as exc:
                if cls._submit_timed_out(exc):
                    await cls.mark_submit_uncertain(
                        database,
                        invocation_id=invocation_id,
                        error=str(exc),
                    )
                    continue
                await InvocationBillingService.rollback_deduction(
                    database,
                    redis_client,
                    user_id=str(flow.get("user_id") or ""),
                    deduction=deduction,
                )
                raise
            except Exception:
                await InvocationBillingService.rollback_deduction(
                    database,
                    redis_client,
                    user_id=str(flow.get("user_id") or ""),
                    deduction=deduction,
                )
                raise
            await database[cls.COLLECTION].update_one(
                {"invocation_id": invocation_id},
                {
                    "$set": {
                        "ai_task_id": task.external_task_id,
                        "external_task_id": task.external_task_id,
                        "model_id": task.model_id,
                        "provider_gateway_status": task.status,
                        "status": task.status,
                        "updated_at": FlowRunStateService._now(),
                    },
                    "$unset": {"submit_error": "", "submit_status": ""},
                },
            )

    @staticmethod
    def _submit_timed_out(exc: BaseException) -> bool:
        if isinstance(exc.__cause__, TimeoutError):
            return True
        message = str(exc).lower()
        return "timed out" in message or "timeout" in message

    @classmethod
    async def mark_submit_uncertain(
        cls,
        database: Any,
        *,
        invocation_id: str,
        error: str,
    ) -> None:
        now = FlowRunStateService._now()
        await database[cls.COLLECTION].update_one(
            {
                "invocation_id": invocation_id,
                "status": {"$in": ["submitting", "running"]},
            },
            {
                "$set": {
                    "status": "running",
                    "submit_error": {
                        "message": error,
                        "phase": "submit_timeout",
                        "recoverable": True,
                    },
                    "submit_status": "uncertain",
                    "submit_timeout_at": now,
                    "updated_at": now,
                }
            },
        )

    @staticmethod
    def _callback_status(status: str) -> str:
        normalized = status.lower()
        if normalized in {"success", "succeeded", "completed"}:
            return "success"
        if normalized in {"timeout", "timed_out"}:
            return "timeout"
        return "failed"

    @staticmethod
    def _callback_result(payload: dict[str, Any]) -> dict[str, Any]:
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    @staticmethod
    def _callback_error(payload: dict[str, Any], status: str) -> dict[str, Any]:
        error = payload.get("error")
        if isinstance(error, dict):
            return error
        if status == "timeout":
            return {"code": "timed_out", "message": "AI task timed out"}
        return {"code": "callback_failed", "message": "AI task failed"}

    @staticmethod
    def _external_task_id(payload: dict[str, Any]) -> str:
        return str(payload.get("external_task_id") or payload.get("ai_task_id") or "")

    @classmethod
    def _invocation_filter(cls, invocation: dict[str, Any]) -> dict[str, Any]:
        if invocation.get("invocation_id"):
            return {"invocation_id": invocation["invocation_id"]}
        if invocation.get("_id") is not None:
            return {"_id": invocation["_id"]}
        return {
            "node_id": invocation.get("node_id"),
            "result_id": invocation.get("result_id"),
            "run_id": invocation.get("run_id"),
        }

    @classmethod
    async def _find_by_vendor_and_external_task(
        cls,
        database: Any,
        *,
        vendor: str,
        external_task_id: str,
    ) -> dict[str, Any] | None:
        if not external_task_id:
            return None
        invocation = await database[cls.COLLECTION].find_one(
            {
                "vendor": vendor,
                "$or": [
                    {"external_task_id": external_task_id},
                    {"ai_task_id": external_task_id},
                ],
            }
        )
        if invocation is not None:
            return invocation
        for key in ("external_task_id", "ai_task_id"):
            invocation = await database[cls.COLLECTION].find_one({key: external_task_id})
            if invocation is not None:
                return invocation
        return None

    @classmethod
    async def _attach_callback_by_trace_id(
        cls,
        database: Any,
        *,
        vendor: str,
        external_task_id: str,
        trace_id: str,
    ) -> dict[str, Any] | None:
        now = FlowRunStateService._now()
        return await database[cls.COLLECTION].find_one_and_update(
            {
                "trace_id": trace_id,
                "$or": [
                    {"external_task_id": {"$exists": False}},
                    {"external_task_id": None},
                ],
            },
            {
                "$set": {
                    "ai_task_id": external_task_id,
                    "external_task_id": external_task_id,
                    "updated_at": now,
                    "vendor": vendor,
                }
            },
            return_document=ReturnDocument.AFTER,
        )

    @classmethod
    async def _record_pending_callback(
        cls,
        database: Any,
        *,
        vendor: str,
        payload: dict[str, Any],
        idempotency_key: str | None,
    ) -> None:
        now = FlowRunStateService._now()
        external_task_id = cls._external_task_id(payload)
        await database[cls.PENDING_CALLBACK_COLLECTION].update_one(
            {"external_task_id": external_task_id, "vendor": vendor},
            {
                "$setOnInsert": {
                    "created_at": now,
                    "external_task_id": external_task_id,
                    "vendor": vendor,
                },
                "$set": {
                    "idempotency_key": idempotency_key,
                    "payload": payload,
                    "status": "pending",
                    "trace_id": payload.get("trace_id"),
                    "updated_at": now,
                },
                "$inc": {"receive_count": 1},
            },
            upsert=True,
        )

    @classmethod
    async def _restore_callback_trace(
        cls,
        database: Any,
        invocation: dict[str, Any],
        *,
        callback_trace_id: str | None,
    ) -> None:
        flow_trace_id = None
        run_id = invocation.get("run_id")
        if run_id:
            flow = await FlowRunStateService.get_flow_run(database, str(run_id))
            if flow:
                flow_trace_id = flow.get("trace_id")
        metadata = invocation.get("metadata") or {}
        set_trace_id(
            callback_trace_id
            or flow_trace_id
            or metadata.get("trace_id")
            or invocation.get("trace_id")
        )

    @classmethod
    async def handle_callback_fast(
        cls,
        database: Any,
        *,
        vendor: str,
        payload: dict[str, Any],
        idempotency_key: str | None,
    ) -> dict[str, Any] | None:
        external_task_id = cls._external_task_id(payload)
        callback_trace_id = str(payload.get("trace_id") or "") or None
        set_trace_id(callback_trace_id)
        invocation = await cls._find_by_vendor_and_external_task(
            database,
            vendor=vendor,
            external_task_id=external_task_id,
        )
        trace_id = str(payload.get("trace_id") or "")
        if invocation is None and trace_id:
            invocation = await cls._attach_callback_by_trace_id(
                database,
                vendor=vendor,
                external_task_id=external_task_id,
                trace_id=trace_id,
            )
        if invocation is None:
            await cls._record_pending_callback(
                database,
                vendor=vendor,
                payload=payload,
                idempotency_key=idempotency_key,
            )
            return None

        await cls._restore_callback_trace(
            database,
            invocation,
            callback_trace_id=callback_trace_id,
        )
        dedupe_keys = list(invocation.get("callback_dedupe_keys") or [])
        if idempotency_key and idempotency_key in dedupe_keys:
            invocation["_schedule_finalize"] = False
            return invocation
        if invocation.get("status") in TERMINAL_INVOCATION_STATUSES:
            invocation["_schedule_finalize"] = invocation.get("finalize_status") == "failed"
            return invocation

        status = cls._callback_status(str(payload.get("status") or ""))
        now = FlowRunStateService._now()
        invocation_id = str(
            invocation.get("invocation_id") or invocation.get("result_id") or external_task_id
        )
        update: dict[str, Any] = {
            "ai_task_id": external_task_id,
            "callback_completed_at": payload.get("completed_at"),
            "callback_error": {} if status == "success" else cls._callback_error(payload, status),
            "callback_payload": payload,
            "callback_result": cls._callback_result(payload),
            "callback_status": status,
            "external_task_id": external_task_id,
            "finalize_status": "pending",
            "invocation_id": invocation_id,
            "provider_gateway_status": payload.get("status"),
            "updated_at": now,
            "usage": payload.get("usage") or {},
            "vendor": vendor,
        }
        if idempotency_key:
            dedupe_keys.append(idempotency_key)
            update["callback_dedupe_keys"] = dedupe_keys
        await database[cls.COLLECTION].update_one(
            cls._invocation_filter(invocation),
            {
                "$set": update,
                "$unset": {
                    "finalize_error": "",
                    "finalize_finished_at": "",
                    "finalize_started_at": "",
                },
            },
        )
        updated = await database[cls.COLLECTION].find_one({"invocation_id": invocation_id})
        if updated is None:
            updated = await database[cls.COLLECTION].find_one(cls._invocation_filter(invocation))
        if updated is None:
            return None
        updated["_schedule_finalize"] = True
        return updated

    @staticmethod
    def _output_bucket_key(node_type: str | None, result: dict[str, Any]) -> str:
        raw_type = str(result.get("type") or node_type or "").lower()
        if "video" in raw_type:
            return "video"
        if "audio" in raw_type or "speech" in raw_type or "music" in raw_type:
            return "audio"
        if "text" in raw_type and "image" not in raw_type:
            return "text"
        return "image"

    @classmethod
    async def _append_node_output(
        cls,
        database: Any,
        *,
        invocation: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        run_id = str(invocation.get("run_id") or "")
        node_id = str(invocation.get("node_id") or "")
        if not run_id or not node_id or not result:
            return
        node_doc = await FlowNodeStateService.get_node(database, run_id, node_id)
        if node_doc is None:
            return
        outputs = dict(node_doc.get("outputs") or {})
        bucket_key = cls._output_bucket_key(
            str((invocation.get("client_context") or {}).get("node_type") or node_doc.get("node_type") or ""),
            result,
        )
        bucket = dict(outputs.get(bucket_key) or {})
        bucket_items = list(bucket.get("outputs") or [])
        formatted = result.get("formatted_output")
        entries = formatted if isinstance(formatted, list) and formatted else [result]
        result_id = str(invocation.get("result_id") or invocation.get("invocation_id") or "")
        model_id = str(invocation.get("model_id") or "")
        for item in entries:
            entry = dict(item) if isinstance(item, dict) else {"value": item}
            if result_id and "result_id" not in entry:
                entry["result_id"] = result_id
            if model_id and "model_id" not in entry:
                entry["model_id"] = model_id
            if entry not in bucket_items:
                bucket_items.append(entry)
        bucket["type"] = bucket_key
        bucket["outputs"] = bucket_items
        outputs[bucket_key] = bucket
        await database[FlowNodeStateService.COLLECTION].update_one(
            {"run_id": run_id, "node_id": node_id},
            {"$set": {"outputs": outputs, "updated_at": FlowRunStateService._now()}},
        )

    @classmethod
    async def complete_from_callback(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        invocation: dict[str, Any],
    ) -> dict[str, Any]:
        status = cls._callback_status(str(invocation.get("callback_status") or ""))
        now = FlowRunStateService._now()
        callback_result = invocation.get("callback_result")
        result = callback_result if isinstance(callback_result, dict) else {}
        update: dict[str, Any] = {
            "error": {} if status == "success" else invocation.get("callback_error") or {},
            "finished_at": now,
            "result": result,
            "status": status,
            "updated_at": now,
        }
        await database[cls.COLLECTION].update_one(
            {"invocation_id": invocation["invocation_id"]},
            {"$set": update},
        )
        updated = await database[cls.COLLECTION].find_one(
            {"invocation_id": invocation["invocation_id"]}
        )
        if updated is None:
            return invocation
        if status == "success":
            await cls._append_node_output(
                database,
                invocation=updated,
                result=result,
            )
            from app.tasks.usage import UsageTask

            await UsageTask.handle_consume(
                database,
                redis_client=redis_client,
                invocation=updated,
                result=result,
                model_usage=updated.get("usage") or {},
            )
        else:
            await InvocationBillingService.rollback_deduction(
                database,
                redis_client,
                user_id=str(updated.get("user_id") or ""),
                deduction=(updated.get("metadata") or {}).get("deduction"),
            )
        from app.services.workflow.node_aggregation_service import NodeAggregationService

        await NodeAggregationService.aggregate_invocation(
            database,
            redis_client=redis_client,
            publisher=publisher,
            invocation=updated,
        )
        return updated

    @classmethod
    async def mark_usage_confirmed_by_deduction_id(
        cls,
        database: Any,
        deduction_id: str,
    ) -> None:
        if not deduction_id:
            return
        now = FlowRunStateService._now()
        await database[cls.COLLECTION].update_many(
            {
                "$or": [
                    {"deduction_id": deduction_id},
                    {"metadata.deduction.deduction_id": deduction_id},
                ]
            },
            {
                "$set": {
                    "updated_at": now,
                    "usage_confirmed_at": now,
                    "usage_status": "confirmed",
                }
            },
        )

    @classmethod
    async def finalize_terminal_invocation(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        invocation: dict[str, Any],
    ) -> dict[str, Any] | None:
        invocation_id = str(invocation.get("invocation_id") or "")
        fresh = None
        if invocation_id:
            fresh = await database[cls.COLLECTION].find_one({"invocation_id": invocation_id})
        current = fresh or invocation
        status = current.get("status")
        if status not in TERMINAL_INVOCATION_STATUSES:
            return current

        if status == "success":
            if current.get("usage_status") != "confirmed":
                from app.tasks.usage import UsageTask

                await UsageTask.handle_consume(
                    database,
                    redis_client=redis_client,
                    invocation=current,
                    result=current.get("result") if isinstance(current.get("result"), dict) else {},
                    model_usage=current.get("usage") or {},
                )
                if invocation_id:
                    current = await database[cls.COLLECTION].find_one(
                        {"invocation_id": invocation_id}
                    ) or current
        elif current.get("rollback_status") != "done":
            await InvocationBillingService.rollback_deduction(
                database,
                redis_client,
                user_id=str(current.get("user_id") or ""),
                deduction=(current.get("metadata") or {}).get("deduction"),
            )
            now = FlowRunStateService._now()
            await database[cls.COLLECTION].update_one(
                {"invocation_id": invocation_id or current.get("invocation_id")},
                {"$set": {"rollback_status": "done", "updated_at": now}},
            )
            if invocation_id:
                current = await database[cls.COLLECTION].find_one(
                    {"invocation_id": invocation_id}
                ) or current

        if (
            current.get("result_write_status") == "done"
            and current.get("model_status_event_status") == "sent"
        ):
            return current

        from app.services.workflow.node_aggregation_service import NodeAggregationService

        await NodeAggregationService.aggregate_invocation(
            database,
            redis_client=redis_client,
            publisher=publisher,
            invocation=current,
        )
        run_id = str(current.get("run_id") or "")
        node_id = str(current.get("node_id") or "")
        node = None
        if run_id and node_id:
            node = await FlowNodeStateService.get_node(database, run_id, node_id)
        if node is not None and node.get("status") in {"success", "failed", "stopped", "select"}:
            now = FlowRunStateService._now()
            await database[cls.COLLECTION].update_one(
                {"invocation_id": invocation_id or current.get("invocation_id")},
                {
                    "$set": {
                        "model_status_event_status": "sent",
                        "result_write_status": "done",
                        "updated_at": now,
                    }
                },
            )
        if invocation_id:
            return await database[cls.COLLECTION].find_one({"invocation_id": invocation_id})
        return current

    @classmethod
    async def complete(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        invocation_id: str,
        status: str,
        error: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        invocation = await database[cls.COLLECTION].find_one({"invocation_id": invocation_id})
        if invocation is None:
            return None
        if invocation.get("status") in TERMINAL_INVOCATION_STATUSES:
            return await cls.finalize_terminal_invocation(
                database,
                redis_client=redis_client,
                publisher=publisher,
                invocation=invocation,
            )

        normalized = status.lower()
        if normalized in {"success", "completed", "succeeded"}:
            stored_status = "success"
        elif normalized in {"timeout", "timed_out"}:
            stored_status = "timeout"
        else:
            stored_status = "failed"
        now = FlowRunStateService._now()
        stored_error = error or {}
        await database[cls.COLLECTION].update_one(
            {"invocation_id": invocation_id},
            {
                "$set": {
                    "callback_error": {} if stored_status == "success" else stored_error,
                    "callback_status": stored_status,
                    "error": {} if stored_status == "success" else stored_error,
                    "finished_at": now,
                    "result": result or {},
                    "status": stored_status,
                    "updated_at": now,
                }
            },
        )
        updated = await database[cls.COLLECTION].find_one({"invocation_id": invocation_id})
        if updated is None:
            return invocation
        return await cls.finalize_terminal_invocation(
            database,
            redis_client=redis_client,
            publisher=publisher,
            invocation=updated,
        )

    @classmethod
    async def handle_ai_task_callback(
        cls,
        database: Any,
        *,
        redis_client: Any | None = None,
        publisher: Any,
        vendor: str,
        payload: dict[str, Any],
        idempotency_key: str | None,
    ) -> dict[str, Any] | None:
        from app.services.invocation.invocation_finalizer import InvocationFinalizer

        invocation = await cls.handle_callback_fast(
            database,
            vendor=vendor,
            payload=payload,
            idempotency_key=idempotency_key,
        )
        if invocation is None or not invocation.get("_schedule_finalize"):
            return invocation
        finalized = await InvocationFinalizer.run_finalize(
            database,
            redis_client=redis_client,
            publisher=publisher,
            invocation_id=str(invocation["invocation_id"]),
        )
        return finalized or invocation
