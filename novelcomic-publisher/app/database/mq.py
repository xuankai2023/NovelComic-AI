"""RabbitMQ consumers for Publisher workflow v2 replies."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

from app.config import get_settings
from app.database.mongo import FLOW_TASK, WORKFLOW_COMMAND
from app.services.workflow_event_store import WorkflowEventStore
from app.services.workflow_runs_v2 import V2_REPLY_QUEUE_NAME

INSTANCE_REPLY_QUEUE_NAME = get_settings().instance_reply_queue


def declared_result_queue_names() -> tuple[str, str]:
    """Instance queue, then the stable v2 queue shared by both colors."""

    return (INSTANCE_REPLY_QUEUE_NAME, V2_REPLY_QUEUE_NAME)


logger = logging.getLogger(__name__)

_TERMINAL_RUN_STATUSES = {"cancelled", "completed", "failed", "killed"}
_IDENTITY_FIELDS = ("event_id", "flow_run_id", "command_id", "protocol_version")
_SHAPE_ERRORS = (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError)


def _decode_message(message: AbstractIncomingMessage) -> dict[str, Any]:
    body = message.body.decode("utf-8")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("workflow v2 reply message must be a JSON object")
    return payload


def _header_value(message: AbstractIncomingMessage, key: str) -> Any:
    properties = getattr(message, "properties", None)
    headers = getattr(properties, "headers", None) if properties is not None else None
    if headers is None:
        headers = getattr(message, "headers", None)
    if not isinstance(headers, dict):
        return None
    value = headers.get(key)
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def _event_status(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    return str(payload.get("status") or event.get("status") or "").lower()


def _status_from_event(event: dict[str, Any]) -> str | None:
    event_type = str(event.get("event_type") or event.get("event") or "")
    event_status = _event_status(event)
    if event_type == "start_flow":
        return "running"
    if event_type == "node_status" and event_status == "select":
        return "waiting_for_selection"
    if event_type in {"finish_flow", "workflow_run.finished"}:
        if event_status in {"fail", "failed", "error", "stopped"}:
            return "failed"
        if event_status in {"", "completed", "success"}:
            return "completed"
        return event_status
    if event_type in {"fail_flow", "workflow_error", "workflow_run.failed"}:
        return "failed"
    if event_type in {"cancel_flow", "flow_killed", "workflow_run.cancelled"}:
        return "killed"
    if event_type == "flow_status":
        if event_status in {"fail", "failed", "error", "stopped"}:
            return "failed"
        if event_status in {"success", "completed"}:
            return "completed"
        if event_status == "select":
            return "waiting_for_selection"
        if event_status == "running":
            return "running"
    return None


def _dispatch_state(status: str) -> str:
    if status == "completed":
        return "completed"
    if status == "failed":
        return "failed"
    if status in {"cancelled", "killed"}:
        return "cancelled"
    return "dispatched"


def _authoritative_status(
    event: dict[str, Any],
    *,
    current_status: str | None,
    current_wire_command_id: str | None,
) -> str | None:
    proposed = _status_from_event(event)
    if current_status in _TERMINAL_RUN_STATUSES:
        return current_status
    if current_status == "cancel_requested" and proposed not in _TERMINAL_RUN_STATUSES:
        return current_status
    if (
        proposed in {"running", "waiting_for_selection"}
        and current_wire_command_id
        and str(event.get("command_id") or "") != str(current_wire_command_id)
    ):
        return current_status
    return proposed


def _prepare_event(
    message: AbstractIncomingMessage,
    event: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    header_protocol = _header_value(message, "protocol_version")
    payload_protocol = event.get("protocol_version")
    protocol_versions = [
        int(value)
        for value in (header_protocol, payload_protocol)
        if value is not None and value != ""
    ]
    if not protocol_versions or any(
        value != WorkflowEventStore.PROTOCOL_VERSION for value in protocol_versions
    ):
        raise ValueError("workflow v2 result requires protocol_version=2")

    header_flow_task_id = _header_value(message, "flow_task_id")
    payload_flow_task_id = event.get("flow_task_id")
    flow_task_ids = [
        str(value)
        for value in (header_flow_task_id, payload_flow_task_id)
        if value is not None and str(value)
    ]
    if not flow_task_ids:
        raise ValueError("workflow v2 result is missing flow_task_id")
    if len(set(flow_task_ids)) != 1:
        raise ValueError("workflow v2 result contains conflicting flow_task_id values")
    flow_task_id = flow_task_ids[0]
    event["flow_task_id"] = flow_task_id

    for field in _IDENTITY_FIELDS:
        header_value = _header_value(message, field)
        payload_value = event.get(field)
        if field == "flow_run_id":
            payload_value = payload_value or event.get("run_id")
        if (
            payload_value is not None
            and header_value is not None
            and str(payload_value) != str(header_value)
        ):
            raise ValueError(f"workflow v2 result contains conflicting {field} values")
        if event.get(field) is None and header_value is not None:
            event[field] = header_value
    if not event.get("flow_run_id") and event.get("run_id"):
        event["flow_run_id"] = event["run_id"]
    event["protocol_version"] = WorkflowEventStore.PROTOCOL_VERSION

    missing_fields = [
        field
        for field in ("event_id", "flow_run_id", "command_id")
        if not isinstance(event.get(field), str) or not event.get(field)
    ]
    if missing_fields:
        raise ValueError(
            "workflow v2 result is missing required fields: " + ", ".join(missing_fields)
        )
    return flow_task_id, event


async def _attach_client_command_id(
    database: Any,
    flow_task_id: str,
    event: dict[str, Any],
) -> None:
    wire_command_id = event.get("command_id")
    if not wire_command_id:
        return
    command = await database[WORKFLOW_COMMAND].find_one(
        {
            "flow_task_id": flow_task_id,
            "protocol_version": WorkflowEventStore.PROTOCOL_VERSION,
            "wire_command_id": str(wire_command_id),
        },
        {"command_id": 1},
    )
    if command and command.get("command_id"):
        event["client_command_id"] = command["command_id"]


def _cursor_update(flow_task_id: str, cursor: str) -> tuple[dict[str, Any], int, int]:
    cursor_ms, cursor_sequence = WorkflowEventStore._cursor_tuple(cursor)
    selector = {
        "$or": [
            {"last_event_cursor_ms": {"$exists": False}},
            {"last_event_cursor_ms": {"$lt": cursor_ms}},
            {
                "last_event_cursor_ms": cursor_ms,
                "last_event_cursor_sequence": {"$lte": cursor_sequence},
            },
        ],
        "flow_task_id": flow_task_id,
        "protocol_version": WorkflowEventStore.PROTOCOL_VERSION,
    }
    return selector, cursor_ms, cursor_sequence


async def _reject_unprocessed(message: AbstractIncomingMessage, *, requeue: bool) -> None:
    if getattr(message, "processed", False):
        return
    await message.reject(requeue=requeue)


async def _nack_unprocessed(message: AbstractIncomingMessage, *, requeue: bool) -> None:
    if getattr(message, "processed", False):
        return
    await message.nack(requeue=requeue)


async def workflow_v2_mq_callback(
    message: AbstractIncomingMessage,
    *,
    database: Any,
    redis_client: Any,
) -> None:
    """校验字段后先 append_event，再前进 cursor，最后才 ACK。

    形状不合法且还没开始落库时 reject 且不重新入队。append_event 开始之后失败则
    nack 并重新入队。重复 event_id 会拿到原来的 cursor，这次仍然 ACK。
    """

    persistence_started = False
    try:
        flow_task_id, event = _prepare_event(message, _decode_message(message))
        await _attach_client_command_id(database, flow_task_id, event)
        current_task = await database[FLOW_TASK].find_one(
            {
                "flow_task_id": flow_task_id,
                "protocol_version": WorkflowEventStore.PROTOCOL_VERSION,
            },
            {"current_wire_command_id": 1, "status": 1},
        )
        current_status = str((current_task or {}).get("status") or "").lower() or None
        current_wire_command_id = (current_task or {}).get("current_wire_command_id")
        proposed_status = _status_from_event(event)
        authoritative_status = _authoritative_status(
            event,
            current_status=current_status,
            current_wire_command_id=(
                str(current_wire_command_id) if current_wire_command_id else None
            ),
        )

        persistence_started = True
        stored_event = await WorkflowEventStore.append_event(
            database,
            flow_task_id,
            redis_client=redis_client,
            event=event,
        )
        cursor = str(stored_event["cursor"])
        selector, cursor_ms, cursor_sequence = _cursor_update(flow_task_id, cursor)
        now = datetime.now(UTC)
        update: dict[str, Any] = {
            "last_event_at": now,
            "last_event_cursor": cursor,
            "last_event_cursor_ms": cursor_ms,
            "last_event_cursor_sequence": cursor_sequence,
            "last_event_id": stored_event["event_id"],
            "updated_at": now,
        }
        flow_run_id = stored_event.get("flow_run_id") or stored_event.get("run_id")
        if flow_run_id:
            update["flow_run_id"] = flow_run_id
        if stored_event.get("trace_id"):
            update["trace_id"] = stored_event["trace_id"]
        if authoritative_status is not None:
            update["status"] = authoritative_status
            if proposed_status is not None and authoritative_status == proposed_status:
                update["dispatch_state"] = _dispatch_state(authoritative_status)
        await database[FLOW_TASK].update_one(selector, {"$set": update})
        await message.ack()
    except _SHAPE_ERRORS as exc:
        if persistence_started:
            logger.exception("workflow v2 reply persistence failed")
            await _nack_unprocessed(message, requeue=True)
            return
        logger.error("workflow v2 reply rejected malformed result error=%s", exc)
        await _reject_unprocessed(message, requeue=False)
    except Exception:
        logger.exception("workflow v2 reply handling failed")
        await _nack_unprocessed(message, requeue=True)


async def workflow_v2_reply_consumer_forever(
    *,
    database: Any,
    redis_client: Any,
    connection: AbstractRobustConnection,
    queue_name: str = V2_REPLY_QUEUE_NAME,
) -> None:
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=50)
    queue = await channel.declare_queue(queue_name, durable=True)

    async def _callback(message: aio_pika.IncomingMessage) -> None:
        await workflow_v2_mq_callback(message, database=database, redis_client=redis_client)

    await queue.consume(_callback)
    await asyncio.Future()


RESULT_CONSUMER_RETRY_SECONDS = 2


async def _stop_result_workers(
    workers: list[asyncio.Task[None]],
    connection: AbstractRobustConnection | None,
) -> None:
    for worker in workers:
        if not worker.done():
            worker.cancel()
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)
    if connection is not None and not connection.is_closed:
        await connection.close()


async def run_main_result_consumers(
    *,
    database: Any,
    redis_client: Any,
    rabbitmq_url: str,
    connect_timeout: float,
) -> None:
    """主进程里唯一的结果消费者。

    同时听实例队列和稳定 v2 队列。不在这里订阅 SQS，也不再为 developer
    进程另起一份 `start_mq_consumer`。
    """

    while True:
        connection: AbstractRobustConnection | None = None
        workers: list[asyncio.Task[None]] = []
        try:
            connection = await aio_pika.connect_robust(rabbitmq_url, timeout=connect_timeout)
            for queue_name in declared_result_queue_names():
                workers.append(
                    asyncio.create_task(
                        workflow_v2_reply_consumer_forever(
                            database=database,
                            redis_client=redis_client,
                            connection=connection,
                            queue_name=queue_name,
                        ),
                        name=f"result-consumer:{queue_name}",
                    )
                )
            await asyncio.gather(*workers)
        except asyncio.CancelledError:
            await _stop_result_workers(workers, connection)
            raise
        except Exception:
            logger.warning("main process result consumer stopped", exc_info=True)
            await _stop_result_workers(workers, connection)
            await asyncio.sleep(RESULT_CONSUMER_RETRY_SECONDS)
