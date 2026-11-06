from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from test_maintenance_scheduler import scheduler_settings
from test_workflow_dag_execution import FakeDatabase, FakePublisher, FakeRedis

from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_recovery_service import FlowRecoveryService
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.tasks.flow_maintenance import (
    MAX_RETRY_TIMES,
    FlowMaintenanceTask,
    MaintenanceStreamWorker,
)
from app.tasks.flow_resume import FlowResumeTask
from app.tasks.setup import register_maintenance_tasks


def _ago(**kwargs: int) -> datetime:
    return datetime.now(UTC) - timedelta(**kwargs)


class QuietRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[Any] = []
        self.acked: list[Any] = []
        self.groups: list[str] = []
        self.release = asyncio.Event()

    async def xgroup_create(self, stream: str, group: str, **kwargs: Any) -> None:
        del kwargs
        self.groups.append(f"{stream}:{group}")

    async def xreadgroup(self, *args: Any, **kwargs: Any) -> list[Any]:
        del args, kwargs
        try:
            await asyncio.wait_for(self.release.wait(), timeout=0.05)
        except TimeoutError:
            return []
        return []

    async def xack(self, stream: str, group: str, message_id: Any) -> int:
        del stream, group
        self.acked.append(message_id)
        return 1


def _completed_run() -> dict[str, Any]:
    return {
        "_id": "run-ok",
        "command_id": "cmd-ok",
        "flow_run_id": "run-ok",
        "flow_task_id": "task-ok",
        "protocol_version": 2,
        "reply_queue": "reply",
        "run_id": "run-ok",
        "start_initialized": True,
        "status": "completed",
        "updated_at": _ago(minutes=1),
    }


@pytest.mark.asyncio
async def test_reconcile_command_only_writes_the_terminal_event() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    await database[FlowRunStateService.COLLECTION].insert_one(_completed_run())
    await database[FlowRunStateService.COLLECTION].insert_one(
        {
            "_id": "run-orphan",
            "command_id": "cmd-orphan",
            "flow_run_id": "run-orphan",
            "flow_task_id": "task-orphan",
            "pending_resume": False,
            "protocol_version": 2,
            "run_id": "run-orphan",
            "start_initialized": True,
            "status": "running",
        }
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        {
            "_id": "run-orphan:model",
            "execution_claim_token": "claim-1",
            "execution_plan_token": "plan-1",
            "execution_plans": [{"result_id": "result-orphan"}],
            "expected_result_ids": ["result-orphan"],
            "is_active": True,
            "node_id": "model",
            "run_id": "run-orphan",
            "started_at": _ago(minutes=10),
            "status": "running",
        }
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-old",
            "execution_mode": "webhook",
            "invocation_id": "inv-old",
            "node_id": "model-old",
            "result_id": "result-old",
            "run_id": "run-old",
            "status": "running",
            "updated_at": _ago(hours=2),
            "vendor": "mock",
        }
    )

    await FlowMaintenanceTask.handle_maintenance(
        database,
        redis_client=FakeRedis(),
        publisher=publisher,
        command="reconcile_terminal_flow_events",
        reason="manual",
    )

    outbox = list(database[FlowEventPublishService.COLLECTION].docs.values())
    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-old"}
    )
    node = await FlowNodeStateService.get_node(database, "run-orphan", "model")
    recorded = await FlowRunStateService.get_flow_run(database, "run-ok")
    assert [item["event_type"] for item in outbox] == ["finish_flow"]
    assert "node_status" not in {item["event_type"] for item in outbox}
    assert invocation is not None
    assert invocation["status"] == "running"
    assert node is not None
    assert node["status"] == "running"
    assert recorded is not None
    assert recorded["terminal_event_outbox_recorded"] is True


@pytest.mark.asyncio
async def test_unknown_command_writes_nothing() -> None:
    database = FakeDatabase()
    await database[FlowRunStateService.COLLECTION].insert_one(_completed_run())
    before = {name: len(collection.docs) for name, collection in database.collections.items()}

    await FlowMaintenanceTask.handle_maintenance(
        database,
        redis_client=FakeRedis(),
        publisher=FakePublisher(),
        command="not-a-maintenance-command",
    )

    after = {name: len(collection.docs) for name, collection in database.collections.items()}
    assert after == before
    assert FlowEventPublishService.COLLECTION not in database.collections


@pytest.mark.asyncio
async def test_recover_running_flows_pushes_resume_with_recover_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resumed: list[tuple[str, str | None]] = []

    async def runs(_database: Any) -> list[str]:
        return ["run-1", "run-2"]

    async def resume(_database: Any, **kwargs: Any) -> None:
        resumed.append((kwargs["run_id"], kwargs["reason"]))

    monkeypatch.setattr(FlowRecoveryService, "recover_running_flows", runs)
    monkeypatch.setattr(FlowResumeTask, "handle_resume", resume)

    await FlowMaintenanceTask.handle_maintenance(
        FakeDatabase(),
        redis_client=FakeRedis(),
        publisher=FakePublisher(),
        command="recover_running_flows",
        reason="scheduler",
    )

    assert resumed == [("run-1", "scheduler"), ("run-2", "scheduler")]


@pytest.mark.asyncio
async def test_failed_maintenance_message_is_acked_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    redis = QuietRedis()
    calls: list[str] = []

    async def boom(*args: Any, **kwargs: Any) -> None:
        del args
        calls.append(str(kwargs["command"]))
        raise RuntimeError("scan failed")

    monkeypatch.setattr(FlowMaintenanceTask, "handle_maintenance", boom)
    worker = MaintenanceStreamWorker(
        database=FakeDatabase(),
        redis_client=redis,
        publisher=FakePublisher(),
        settings=scheduler_settings(),
    )
    await worker._handle_message(
        "4-0",
        {
            "command": "reconcile_terminal_flow_events",
            "payload": '{"command":"reconcile_terminal_flow_events","reason":"manual"}',
            "reason": "manual",
        },
    )

    assert MAX_RETRY_TIMES == 0
    assert worker.MAX_RETRY_TIMES == 0
    assert calls == ["reconcile_terminal_flow_events"]
    assert redis.acked == ["4-0"]
    assert redis.messages == []


@pytest.mark.asyncio
async def test_disabled_scheduler_starts_consumer_without_new_commands() -> None:
    redis = QuietRedis()
    runtime = register_maintenance_tasks(
        FakeDatabase(),
        redis,
        FakePublisher(),
        settings=scheduler_settings(flow_maintenance_scheduler_enabled=False),
        instance_id="consumer-a",
    )
    try:
        for _ in range(20):
            if redis.groups:
                break
            await asyncio.sleep(0)
        assert runtime.scheduler is None
        assert runtime.worker.stream == "flow_maintenance"
        assert redis.messages == []
        assert redis.groups == ["flow_maintenance:novelcomic_consumer_group"]
    finally:
        runtime.stop()
        redis.release.set()
        await runtime.wait_stopped()
