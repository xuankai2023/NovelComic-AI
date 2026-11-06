"""Workflow task instrumentation and Redis Stream entry points."""

import asyncio
import json
import logging
from datetime import datetime
from time import time
from typing import Any
from uuid import uuid4

from app.config import get_settings
from app.database.mq import V2_REPLY_QUEUE_NAME
from app.logger.logger import log
from app.services.b2b_signal.service import emit_event
from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.tasks.flow_resume import FlowResumeTask
from app.utils.drainable_consumer import DrainableRedisStreamConsumer
from app.utils.trace_context import set_trace_id

logger = logging.getLogger(__name__)

FLOW_START_LOCK_PREFIX = "opencreator:flow_start_lock:"


class RunFlowStream:
    """Redis Stream transport for ``run_flow``.

    This is the Consumer equivalent of OpenCreator ``FlowTask.run_flow.aio_push``.
    It appends the original payload and does not create a new command id.
    """

    queue_name = "run_flow"

    @staticmethod
    def _encode_field(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int | float):
            return str(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)

    @classmethod
    def message(cls, payload: dict[str, Any]) -> dict[str, str]:
        body = {
            "command_id": payload.get("command_id"),
            "dag": {} if payload.get("dag") is None else payload.get("dag"),
            "end_ids": list(payload.get("end_ids") or []),
            "flow_run_id": payload.get("flow_run_id") or "",
            "flow_task_id": payload.get("flow_task_id") or "",
            "protocol_version": 2
            if payload.get("protocol_version") is None
            else payload.get("protocol_version"),
            "reply_queue": payload.get("reply_queue") or "",
            "start_ids": list(payload.get("start_ids") or []),
            "trace_id": payload.get("trace_id") or "",
            "user_selection": {}
            if payload.get("user_selection") is None
            else payload.get("user_selection"),
        }
        for key, value in payload.items():
            body.setdefault(key, value)
        encoded = {key: cls._encode_field(value) for key, value in body.items()}
        encoded["payload"] = cls._encode_field(body)
        task_id = body.get("flow_task_id") or ""
        if task_id:
            encoded["task_id"] = str(task_id)
        return encoded

    @classmethod
    async def aio_push(cls, redis_client: Any, **payload: Any) -> str:
        if redis_client is None:
            raise RuntimeError("redis_client is required")
        message_id = await redis_client.xadd(cls.resolved_queue_name(), cls.message(payload))
        if isinstance(message_id, bytes):
            return message_id.decode()
        return str(message_id)

    @classmethod
    def resolved_queue_name(cls) -> str:
        configured = get_settings().run_flow_queue_name.strip()
        return configured or cls.queue_name


def _run_lost_to_terminal(flow: dict[str, Any] | None) -> bool:
    if not flow:
        return True
    if flow.get("cancel_requested"):
        return True
    if flow.get("terminal_owner") in {"cancel", "finish"}:
        return True
    return flow.get("status") != "running"


def _decode_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode()
    return value


def _loads_if_json(value: Any) -> Any:
    value = _decode_value(value)
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped:
        return value
    if stripped[0] not in "[{\"" and stripped not in {"true", "false", "null"}:
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def decode_stream_payload(fields: dict[Any, Any]) -> dict[str, Any]:
    decoded = {str(_decode_value(key)): _loads_if_json(value) for key, value in fields.items()}
    payload = decoded.get("payload")
    if isinstance(payload, dict):
        merged = {**decoded, **payload}
        merged.pop("payload", None)
        return merged
    return decoded


def _message_trace_id(payload: dict[str, Any]) -> str | None:
    trace_id = payload.get("trace_id")
    if isinstance(trace_id, str) and trace_id:
        return trace_id
    return None


def _observe_flow_entry(payload: dict[str, Any]) -> None:
    """挂上消息里的 trace，并记录领取延迟。失败只跳过观测。"""

    trace_id = _message_trace_id(payload)
    set_trace_id(trace_id)
    flow_task_id = str(payload.get("flow_task_id") or "")
    flow_run_type = str(payload.get("flow_run_type") or "")
    user_id = str(payload.get("user_id") or "")
    log.info(
        "run_flow received flow_task_id=%s command_id=%s",
        flow_task_id,
        payload.get("command_id") or "",
    )

    raw_timestamp = payload.get("publish_timestamp")
    if raw_timestamp not in (None, ""):
        try:
            import sentry_sdk

            queue_delay = max(0, round(time() - float(raw_timestamp), 3))
            sentry_sdk.metrics.distribution(
                "flow.queue_delay",
                queue_delay,
                unit="second",
                attributes={"flow_run_type": flow_run_type},
            )
        except Exception:
            pass

    try:
        import sentry_sdk

        sentry_trace = payload.get("sentry_trace") or ""
        if sentry_trace:
            transaction = sentry_sdk.continue_trace(
                {
                    "sentry-trace": sentry_trace,
                    "baggage": payload.get("sentry_baggage") or "",
                },
                op="flow.run",
                name=f"flow:{flow_task_id}",
            )
            sentry_sdk.start_transaction(transaction=transaction)
    except Exception:
        pass

    try:
        import sentry_sdk

        ws_id = payload.get("ws_id") or payload.get("reply_channel_id") or ""
        sentry_sdk.set_tag("trace_id", trace_id or "")
        sentry_sdk.set_tag("flow_task_id", flow_task_id)
        sentry_sdk.set_tag("flow_id", payload.get("flow_id") or "")
        sentry_sdk.set_tag("user_id", user_id)
        sentry_sdk.set_tag("command_id", payload.get("command_id") or "")
        sentry_sdk.set_tag("protocol_version", payload.get("protocol_version") or "")
        sentry_sdk.set_tag("ws_id", ws_id)
        sentry_sdk.set_user({"id": user_id})
    except Exception:
        pass


class FlowTask:
    @staticmethod
    async def run_flow(
        database: Any,
        payload: dict[str, Any],
        *,
        publisher: Any,
        redis_client: Any | None = None,
    ) -> None:
        _observe_flow_entry(payload)
        protocol_version = int(payload.get("protocol_version") or 1)
        command_id = str(payload.get("command_id") or "")
        flow_run_type = str(payload.get("flow_run_type") or "start")
        flow_task_id = str(payload.get("flow_task_id") or "")
        flow_run_id = str(payload.get("flow_run_id") or flow_task_id)
        dag = payload.get("dag") or {"nodes": [], "edges": []}

        if protocol_version != 2:
            raise ValueError("workflow consumer currently supports protocol_version=2")
        if not command_id:
            raise ValueError("workflow protocol v2 requires command_id")
        if flow_run_type not in {"start", "continue", "cancel"}:
            raise ValueError(
                "only start, continue and cancel commands are implemented in this step"
            )

        command_payload = {
            "dag": dag,
            "end_ids": payload.get("end_ids") or [],
            "flow_id": payload.get("flow_id"),
            "flow_run_id": flow_run_id,
            "flow_run_type": flow_run_type,
            "flow_task_id": flow_task_id,
            "locale": payload.get("locale"),
            "reply_queue": payload.get("reply_queue"),
            "start_ids": payload.get("start_ids") or [],
            "trace_id": payload.get("trace_id"),
            "user_id": payload.get("user_id") or "",
            "user_selection": payload.get("user_selection") or {},
            "ws_id": payload.get("ws_id") or payload.get("reply_channel_id") or "",
        }
        claim = await FlowCommandInboxService.claim_command(
            database,
            command_id=command_id,
            protocol_version=protocol_version,
            command_type=flow_run_type,
            flow_task_id=flow_task_id,
            flow_run_id=flow_run_id,
            payload=command_payload,
            redelivery_payload=payload,
        )
        if not claim.claimed:
            level = logging.ERROR if claim.conflict else logging.INFO
            logger.log(
                level,
                "workflow command ignored command_id=%s flow_task_id=%s conflict=%s",
                command_id,
                flow_task_id,
                claim.conflict,
            )
            return

        lease_token = claim.lease_token or ""
        try:
            if flow_run_type == "cancel":
                flow = await FlowRunStateService.request_cancel(
                    database,
                    run_id=flow_run_id,
                    command_id=command_id,
                )
                if flow is not None and flow.get("status") == "running":
                    await FlowResumeTask._stop_flow_for_kill(
                        database,
                        publisher=publisher,
                        flow=flow,
                    )
            elif flow_run_type == "continue":
                flow = await FlowRunStateService.get_flow_run(database, flow_run_id)
                if flow is not None and flow.get("status") == "running":
                    apply_result = await FlowNodeStateService.apply_user_selection_for_continue(
                        database,
                        run_id=flow_run_id,
                        user_selection=command_payload["user_selection"],
                        command_id=command_id,
                    )
                    restored = apply_result.get("restored_select_to_success", 0)
                    recovered = apply_result.get("already_applied_select_to_success", 0)
                    if restored > 0 or recovered > 0:
                        await FlowRunStateService.mark_pending_resume(database, flow_run_id, True)
                        await FlowResumeTask.handle_resume(
                            database,
                            redis_client=redis_client,
                            run_id=flow_run_id,
                            reason="continue",
                            trace_id=command_payload["trace_id"],
                            publisher=publisher,
                        )
                    else:
                        logger.warning(
                            "continue command ignored because no select node was restored "
                            "command_id=%s flow_run_id=%s",
                            command_id,
                            flow_run_id,
                        )
            else:
                await FlowTask._bootstrap_start(
                    database,
                    redis_client=redis_client,
                    publisher=publisher,
                    command_id=command_id,
                    protocol_version=protocol_version,
                    flow_task_id=flow_task_id,
                    flow_run_id=flow_run_id,
                    dag=dag,
                    command_payload=command_payload,
                )
        except Exception as exc:
            await FlowCommandInboxService.mark_failed(database, command_id, lease_token, str(exc))
            raise
        await FlowCommandInboxService.mark_completed(database, command_id, lease_token)

    @staticmethod
    async def _bootstrap_start(
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        command_id: str,
        protocol_version: int,
        flow_task_id: str,
        flow_run_id: str,
        dag: dict[str, Any],
        command_payload: dict[str, Any],
    ) -> None:
        if redis_client is None:
            raise RuntimeError("workflow start requires redis start lock")

        lock_key = f"{FLOW_START_LOCK_PREFIX}{flow_run_id}"
        locked = await redis_client.set(
            lock_key,
            uuid4().hex,
            ex=get_settings().flow_start_lock_ttl_seconds,
            nx=True,
        )
        existing = await FlowRunStateService.get_flow_run(database, flow_run_id)
        if not locked and existing is None:
            # The previous worker still holds the start lock and has not inserted
            # the run. Completing the inbox here would hide a missing bootstrap.
            raise RuntimeError("workflow start lock is held but durable run is missing")
        if existing is not None and _run_lost_to_terminal(existing):
            logger.info(
                "start blocked by terminal run command_id=%s flow_run_id=%s status=%s",
                command_id,
                flow_run_id,
                existing.get("status"),
            )
            return
        if existing is not None and existing.get("start_initialized"):
            logger.info(
                "start already initialized command_id=%s flow_run_id=%s",
                command_id,
                flow_run_id,
            )
            return
        if existing is None:
            initialized = await FlowRunStateService.init_flow_run(
                database,
                run_id=flow_run_id,
                flow_task_id=flow_task_id,
                user_id=command_payload["user_id"],
                ws_id=command_payload["ws_id"],
                dag=dag,
                start_ids=command_payload["start_ids"],
                end_ids=command_payload["end_ids"],
                reply_queue=command_payload["reply_queue"],
                trace_id=command_payload["trace_id"],
                flow_id=command_payload["flow_id"],
                locale=command_payload["locale"],
                command_id=command_id,
                protocol_version=protocol_version,
                user_selection=command_payload["user_selection"],
            )
            if _run_lost_to_terminal(initialized):
                logger.info(
                    "start bootstrap lost at init command_id=%s flow_run_id=%s status=%s",
                    command_id,
                    flow_run_id,
                    (initialized or {}).get("status"),
                )
                return
        else:
            logger.warning(
                "repairing start abandoned before initialization command_id=%s flow_run_id=%s",
                command_id,
                flow_run_id,
            )

        await FlowNodeStateService.init_nodes(
            database,
            run_id=flow_run_id,
            dag=dag,
            start_ids=command_payload["start_ids"],
            end_ids=command_payload["end_ids"],
        )
        await FlowNodeStateService.seed_user_selection_outputs(
            database,
            run_id=flow_run_id,
            user_selection=command_payload["user_selection"],
        )
        refreshed = await FlowRunStateService.get_flow_run(database, flow_run_id)
        if _run_lost_to_terminal(refreshed):
            if refreshed and (
                refreshed.get("cancel_requested") or refreshed.get("terminal_owner") == "cancel"
            ):
                await FlowResumeTask._stop_flow_for_kill(
                    database,
                    publisher=publisher,
                    flow=refreshed,
                )
            logger.info(
                "start bootstrap lost after node init command_id=%s flow_run_id=%s status=%s",
                command_id,
                flow_run_id,
                (refreshed or {}).get("status"),
            )
            return

        reply_queue = str(command_payload.get("reply_queue") or V2_REPLY_QUEUE_NAME)
        await FlowEventPublishService.publish(
            database,
            publisher,
            queue_name=reply_queue,
            flow_task_id=flow_task_id,
            flow_run_id=flow_run_id,
            command_id=command_id,
            event_type="start_flow",
            event_id=FlowEventPublishService.stable_event_id("start_flow", flow_run_id),
            payload={"flow_run_id": flow_run_id, "run_id": flow_run_id},
        )
        await FlowResumeTask.handle_resume(
            database,
            redis_client=redis_client,
            run_id=flow_run_id,
            reason="start",
            trace_id=command_payload["trace_id"],
            publisher=publisher,
        )
        await FlowRunStateService.mark_start_initialized(database, flow_run_id)


class FlowStreamWorker:
    GROUP = "novelcomic_consumer_group"

    def __init__(
        self,
        *,
        database: Any,
        redis_client: Any,
        publisher: Any,
        consumer_name: str = "consumer",
    ) -> None:
        self.database = database
        self.redis = redis_client
        self.publisher = publisher
        self.consumer_name = consumer_name
        self.stream = RunFlowStream.resolved_queue_name()
        self._stop_event = asyncio.Event()
        self.intake = DrainableRedisStreamConsumer(
            redis_client,
            instance_id=get_settings().consumer_instance_id,
            queue_name=self.stream,
            group=self.GROUP,
            consumer_name=consumer_name,
            stop_event=self._stop_event,
        )

    async def run(self) -> None:
        await self.intake.startup()
        await self._ensure_group()
        while not self._stop_event.is_set():
            messages = await self.intake.read_once()
            for _stream_name, entries in messages:
                for message_id, fields in entries:
                    await self._handle_message(message_id, fields)

    def stop(self) -> None:
        self._stop_event.set()

    async def _ensure_group(self) -> None:
        try:
            await self.redis.xgroup_create(self.stream, self.GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def _handle_message(self, message_id: Any, fields: dict[Any, Any]) -> None:
        payload = decode_stream_payload(fields)
        await self.intake.add_inflight(message_id)
        try:
            await FlowTask.run_flow(
                self.database,
                payload,
                publisher=self.publisher,
                redis_client=self.redis,
            )
        except Exception:
            logger.exception("run_flow message failed message_id=%s", message_id)
            return
        finally:
            await self.intake.remove_inflight(message_id)
        await self.redis.xack(self.stream, self.GROUP, message_id)


async def emit_flow_task_started(
    database: Any,
    *,
    user_id: str,
    flow_task_id: str,
    flow_id: str | None = None,
    occurred_at: datetime | None = None,
) -> None:
    metadata = {"flow_id": flow_id} if flow_id else {}
    await emit_event(
        database,
        user_id=user_id,
        event_type="flow_task_started",
        source_id=flow_task_id,
        metadata=metadata,
        occurred_at=occurred_at,
    )
