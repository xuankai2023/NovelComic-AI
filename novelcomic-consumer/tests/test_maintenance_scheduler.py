from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from test_workflow_dag_execution import FakeDatabase, FakePublisher

from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.tasks.setup import (
    MAINTENANCE_SCHEDULER_LOCK_PREFIX,
    MaintenanceScheduler,
    start_maintenance_scheduler,
)


def scheduler_settings(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "flow_command_inbox_sweep_interval_seconds": 10,
        "flow_maintenance_interval_seconds": 60,
        "flow_maintenance_queue_name": "flow_maintenance",
        "flow_maintenance_scheduler_enabled": True,
        "flow_recover_running_interval_seconds": 300,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class LockRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.sets: list[dict[str, Any]] = []
        self.messages: list[tuple[str, dict[str, str]]] = []

    async def set(
        self,
        key: str,
        value: Any,
        *,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        self.sets.append({"ex": ex, "key": key, "nx": nx, "value": value})
        if nx and key in self.values:
            return None
        self.values[key] = value.decode() if isinstance(value, bytes) else str(value)
        return True

    async def xadd(self, queue_name: str, message: dict[str, str]) -> str:
        self.messages.append((queue_name, dict(message)))
        return f"{len(self.messages)}-0"


def replay_messages(redis: LockRedis) -> list[dict[str, str]]:
    return [
        fields
        for queue_name, fields in redis.messages
        if queue_name == "flow_maintenance" and fields["command"] == "replay_due_outbox_events"
    ]


@pytest.mark.asyncio
async def test_two_schedulers_enqueue_replay_due_outbox_events_once() -> None:
    redis = LockRedis()
    settings = scheduler_settings()
    first = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-a")
    second = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-b")

    first_pushed = await first.tick(now=1_000)
    second_pushed = await second.tick(now=1_000)

    assert "replay_due_outbox_events" in first_pushed
    assert "replay_due_outbox_events" not in second_pushed
    assert len(replay_messages(redis)) == 1
    message = replay_messages(redis)[0]
    assert json.loads(message["payload"]) == {
        "command": "replay_due_outbox_events",
        "reason": "scheduler",
    }
    lock_key = f"{MAINTENANCE_SCHEDULER_LOCK_PREFIX}replay_due_outbox_events"
    assert redis.values[lock_key] == "consumer-a"
    lock_calls = [item for item in redis.sets if item["key"] == lock_key]
    assert lock_calls[0]["ex"] == 59
    assert lock_calls[0]["nx"] is True
    sweep_key = f"{MAINTENANCE_SCHEDULER_LOCK_PREFIX}redeliver_due_workflow_commands"
    recover_key = f"{MAINTENANCE_SCHEDULER_LOCK_PREFIX}recover_running_flows"
    assert next(item["ex"] for item in redis.sets if item["key"] == sweep_key) == 9
    assert next(item["ex"] for item in redis.sets if item["key"] == recover_key) == 299


@pytest.mark.asyncio
async def test_lock_blocks_the_other_instance_until_it_expires() -> None:
    redis = LockRedis()
    settings = scheduler_settings()
    holder = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-a")
    other = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-b")

    await holder.tick(now=1_000)
    assert await holder.tick(now=1_059) == []
    assert "replay_due_outbox_events" not in await other.tick(now=1_060)
    assert len(replay_messages(redis)) == 1

    lock_key = f"{MAINTENANCE_SCHEDULER_LOCK_PREFIX}replay_due_outbox_events"
    del redis.values[lock_key]
    follower = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-c")
    assert "replay_due_outbox_events" in await follower.tick(now=1_060)
    assert len(replay_messages(redis)) == 2
    assert redis.values[lock_key] == "consumer-c"


@pytest.mark.asyncio
async def test_disabled_scheduler_does_not_start_and_leases_still_reject_duplicates() -> None:
    redis = LockRedis()
    disabled = scheduler_settings(flow_maintenance_scheduler_enabled=False)
    assert start_maintenance_scheduler(redis, settings=disabled, instance_id="consumer-a") is None
    scheduler = MaintenanceScheduler(redis, settings=disabled, instance_id="consumer-a")
    assert await scheduler.tick(now=1_000) == []
    assert redis.messages == []
    assert redis.sets == []

    database = FakeDatabase()
    publisher = FakePublisher()
    claim_kwargs = {
        "command_id": "cmd-lease",
        "protocol_version": 2,
        "command_type": "start",
        "flow_task_id": "task-lease",
        "flow_run_id": "run-lease",
        "payload": {"dag": {"nodes": []}},
        "redelivery_payload": {"command_id": "cmd-lease"},
    }
    first = await FlowCommandInboxService.claim_command(database, **claim_kwargs)
    second = await FlowCommandInboxService.claim_command(database, **claim_kwargs)
    assert first.claimed is True
    assert second.claimed is False
    assert second.conflict is False

    event_id = FlowEventPublishService.stable_event_id("node_status", "scheduler-off")
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        payload={"status": "running"},
    )
    await FlowEventPublishService.publish(
        database,
        publisher,
        queue_name="reply",
        flow_task_id="task-lease",
        flow_run_id="run-lease",
        command_id="cmd-lease",
        event_type="node_status",
        event_id=event_id,
        payload={"status": "running"},
    )
    assert len(publisher.messages) == 1


@pytest.mark.asyncio
async def test_enabled_loop_pushes_once_and_stops() -> None:
    redis = LockRedis()
    settings = scheduler_settings(flow_maintenance_interval_seconds=1)
    scheduler = start_maintenance_scheduler(redis, settings=settings, instance_id="consumer-a")
    assert scheduler is not None
    try:
        for _ in range(20):
            if replay_messages(redis):
                break
            await asyncio.sleep(0)
        assert len(replay_messages(redis)) == 1
        assert replay_messages(redis)[0]["reason"] == "scheduler"
    finally:
        scheduler.stop()
        await scheduler.wait_stopped()

    queued = len(redis.messages)
    await asyncio.sleep(0)
    assert len(redis.messages) == queued


@pytest.mark.asyncio
async def test_short_interval_uses_a_positive_lock_ttl() -> None:
    redis = LockRedis()
    settings = scheduler_settings(
        flow_command_inbox_sweep_interval_seconds=1,
        flow_maintenance_interval_seconds=1,
        flow_recover_running_interval_seconds=1,
    )
    scheduler = MaintenanceScheduler(redis, settings=settings, instance_id="consumer-a")

    await scheduler.tick(now=1_000)

    assert redis.sets
    assert {item["ex"] for item in redis.sets} == {1}
