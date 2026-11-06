from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from novelcomic_agent.services.agent_redis_run_store import RedisRunStore
from novelcomic_agent.workflow.task_publisher import (
    DEFAULT_RUN_FLOW_QUEUE,
    RUN_FLOW_QUEUE_ENV,
    run_flow,
)


class MemoryRedis:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.messages: list[tuple[str, dict[str, Any]]] = []

    async def set(
        self,
        key: str,
        value: Any,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        del ex
        if nx and key in self.values:
            return None
        self.values[key] = value
        return True

    async def get(self, key: str) -> Any:
        return self.values.get(key)

    async def xadd(self, queue_name: str, message: dict[str, Any]) -> bytes:
        self.messages.append((queue_name, dict(message)))
        return b"9-1"


def test_task_publisher_does_not_reference_canvas_ledgers_or_run_store() -> None:
    source = Path(__file__).resolve().parents[1].joinpath(
        "src/novelcomic_agent/workflow/task_publisher.py"
    )
    text = source.read_text()
    assert "flow_command_inbox" not in text
    assert "flow_event_outbox" not in text
    assert "RedisRunStore" not in text


@pytest.mark.asyncio
async def test_publish_writes_only_the_run_flow_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(RUN_FLOW_QUEUE_ENV, "run_flow_agent")
    redis = MemoryRedis()

    message_id = await run_flow.publish(
        {
            "command_id": "cmd-1",
            "dag": {"nodes": [{"id": "n"}], "edges": []},
            "end_ids": ["n"],
            "flow_id": "flow-1",
            "flow_run_id": "run-1",
            "flow_run_type": "start",
            "flow_task_id": "task-1",
            "session_id": "session-1",
            "source": "agent",
            "start_ids": ["n"],
            "trace_id": "trace-1",
            "user_id": "user-1",
            "user_selection": {"n": {"text": "hello"}},
            "reply_queue": "reply",
        },
        redis_client=redis,
        task_id="task-1",
    )

    assert message_id == "9-1"
    assert run_flow.queue_name == "run_flow_agent"
    assert len(redis.messages) == 1
    assert redis.values == {}
    queue_name, fields = redis.messages[0]
    assert queue_name == "run_flow_agent"
    assert fields["task_id"] == "task-1"
    body = json.loads(fields["payload"])
    assert body["command_id"] == "cmd-1"
    assert body["protocol_version"] == 2
    assert body["source"] == "agent"
    assert body["session_id"] == "session-1"
    assert body["dag"]["nodes"][0]["id"] == "n"
    assert "flow_command_inbox" not in json.dumps(fields)
    assert "flow_event_outbox" not in json.dumps(fields)


@pytest.mark.asyncio
async def test_publish_defaults_queue_and_protocol_without_touching_session_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(RUN_FLOW_QUEUE_ENV, raising=False)
    redis = MemoryRedis()
    store = RedisRunStore(redis)
    assert await store.acquire_session_run_lock("session-1", "sse-owner") is True

    await run_flow.publish(
        redis_client=redis,
        flow_task_id="task-2",
        flow_run_id="run-2",
        command_id="cmd-2",
        source="agent",
    )

    assert run_flow.queue_name == DEFAULT_RUN_FLOW_QUEUE
    assert redis.messages[0][0] == DEFAULT_RUN_FLOW_QUEUE
    body = json.loads(redis.messages[0][1]["payload"])
    assert body["protocol_version"] == 2
    assert body["command_id"] == "cmd-2"
    assert body["dag"] == {}
    assert redis.values[RedisRunStore.session_run_lock_key("session-1")] == "sse-owner"
    assert await store.acquire_session_run_lock("session-1", "other") is False
