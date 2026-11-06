"""Publish a workflow command onto the shared ``run_flow`` stream.

This process only writes the Redis Stream message. It does not insert the
canvas command inbox or event outbox, and it does not execute the DAG.
Consumer Inbox decides how many times that command's side effects run.
Agent SSE locks and the resume window stay in the agent run store.
"""

from __future__ import annotations

import json
import os
from typing import Any

RUN_FLOW_QUEUE_ENV = "CREATO_WORKFLOW__RUN_FLOW_QUEUE"
DEFAULT_RUN_FLOW_QUEUE = "run_flow"


def run_flow_queue_name() -> str:
    """Return the stream name shared with Publisher and Consumer."""

    configured = os.getenv(RUN_FLOW_QUEUE_ENV, "").strip()
    return configured or DEFAULT_RUN_FLOW_QUEUE


class _RedisStreamPublisher:
    """Stream publisher. The function body never runs the workflow."""

    broker_kind = "REDIS_STREAM"

    @property
    def queue_name(self) -> str:
        return run_flow_queue_name()

    @staticmethod
    def transport_body(payload: dict[str, Any]) -> dict[str, Any]:
        """Redis Stream transport only. No inbox, outbox, run, or node writes."""

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
        return body

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

    async def publish(
        self,
        payload: dict[str, Any] | None = None,
        *,
        redis_client: Any,
        task_id: str | None = None,
        **fields: Any,
    ) -> str:
        """Append one ``run_flow`` message. ``payload`` may also be passed positionally."""

        if redis_client is None:
            raise ValueError("redis_client is required")
        body_input = dict(payload or {})
        body_input.update(fields)
        body = self.transport_body(body_input)
        message = {key: self._encode_field(value) for key, value in body.items()}
        message["payload"] = self._encode_field(body)
        resolved_task_id = task_id or body.get("flow_task_id") or ""
        if resolved_task_id:
            message["task_id"] = str(resolved_task_id)
        message_id = await redis_client.xadd(self.queue_name, message)
        if isinstance(message_id, bytes):
            return message_id.decode()
        return str(message_id)


run_flow = _RedisStreamPublisher()
