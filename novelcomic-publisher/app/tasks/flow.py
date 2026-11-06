"""Publisher-side workflow task queue publishers."""

from __future__ import annotations

import json
from typing import Any


class _RedisStreamPublisher:
    queue_name = "run_flow"
    broker_kind = "REDIS_STREAM"

    @staticmethod
    def transport_body(payload: dict[str, Any]) -> dict[str, Any]:
        """Redis Stream transport only. No inbox, run, or node writes."""

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
        *,
        redis_client: Any,
        payload: dict[str, Any],
        task_id: str | None = None,
    ) -> str:
        body = self.transport_body(payload)
        message = {key: self._encode_field(value) for key, value in body.items()}
        message["payload"] = self._encode_field(body)
        if task_id:
            message["task_id"] = task_id
        message_id = await redis_client.xadd(self.queue_name, message)
        if isinstance(message_id, bytes):
            return message_id.decode()
        return str(message_id)


class FlowTask:
    run_flow = _RedisStreamPublisher()
