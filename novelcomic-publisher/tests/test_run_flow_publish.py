from __future__ import annotations

import json
from typing import Any

import pytest

from app.services.flow import FlowService
from app.tasks.flow import FlowTask


class FakeRedis:
    def __init__(self) -> None:
        self.messages: list[tuple[str, dict[str, Any]]] = []

    async def xadd(self, queue_name: str, message: dict[str, Any]) -> str:
        self.messages.append((queue_name, dict(message)))
        return "1-0"


@pytest.mark.asyncio
async def test_run_flow_publish_writes_v2_transport_fields() -> None:
    redis = FakeRedis()
    published = await FlowService.enqueue_flow_task(
        redis_client=redis,
        nodes=[{"id": "n", "type": "textInput"}],
        edges=[],
        reply_channel_id="v2:task-1",
        flow_task_id="task-1",
        flow_id="flow-1",
        flow_run_type="start",
        flow_run_id="run-1",
        user_selection={"n": {"asset": "chosen"}},
        start_ids=["n"],
        end_ids=["n"],
        user_id="user-1",
        reply_queue_name="flow_result.workflow.v2",
        trace_id="trace-1",
        command_id="wfc_abc",
        protocol_version=2,
    )

    assert published["flow_task_id"] == "task-1"
    assert published["flow_run_id"] == "run-1"
    assert published["trace_id"] == "trace-1"
    assert len(redis.messages) == 1
    queue_name, fields = redis.messages[0]
    assert queue_name == "run_flow"
    body = json.loads(fields["payload"])
    assert body["flow_task_id"] == "task-1"
    assert body["flow_run_id"] == "run-1"
    assert body["dag"]["nodes"][0]["id"] == "n"
    assert body["user_selection"] == {"n": {"asset": "chosen"}}
    assert body["start_ids"] == ["n"]
    assert body["end_ids"] == ["n"]
    assert body["reply_queue"] == "flow_result.workflow.v2"
    assert body["command_id"] == "wfc_abc"
    assert body["protocol_version"] == 2
    assert body["trace_id"] == "trace-1"
    assert body["sentry_trace"] == ""
    assert body["sentry_baggage"] == ""
    assert isinstance(body["publish_timestamp"], int | float)
    assert fields["command_id"] == "wfc_abc"
    assert fields["protocol_version"] == "2"


@pytest.mark.asyncio
async def test_run_flow_publish_fills_missing_v2_fields_without_other_writes() -> None:
    redis = FakeRedis()
    message_id = await FlowTask.run_flow.publish(
        redis_client=redis,
        payload={"flow_task_id": "task-2", "command_id": "wfc_only"},
    )

    assert message_id == "1-0"
    body = json.loads(redis.messages[0][1]["payload"])
    assert body["protocol_version"] == 2
    assert body["flow_run_id"] == ""
    assert body["dag"] == {}
    assert body["user_selection"] == {}
    assert body["start_ids"] == []
    assert body["end_ids"] == []
    assert body["reply_queue"] == ""
    assert body["command_id"] == "wfc_only"
    assert body["trace_id"] == ""
    assert redis.messages[0][0] == "run_flow"
