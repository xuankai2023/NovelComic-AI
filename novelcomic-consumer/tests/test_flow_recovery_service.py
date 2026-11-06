from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from test_workflow_dag_execution import FakeDatabase, FakePublisher, FakeRedis

from app.services.invocation.model_invocation_service import ModelInvocationService
from app.services.opencreator_ai.errors import OC_AI_WORKER_TIMEOUT_ERROR_CODE
from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService
from app.services.workflow.flow_event_publish_service import FlowEventPublishService
from app.services.workflow.flow_node_state_service import FlowNodeStateService
from app.services.workflow.flow_recovery_service import FlowRecoveryService
from app.services.workflow.flow_run_state_service import FlowRunStateService
from app.tasks.flow import FlowTask, decode_stream_payload
from app.tasks.flow_resume import FlowResumeTask


def _ago(**kwargs: int) -> datetime:
    return datetime.now(UTC) - timedelta(**kwargs)


def _node(run_id: str, node_id: str, **fields: Any) -> dict[str, Any]:
    document = {
        "_id": f"{run_id}:{node_id}",
        "is_active": True,
        "node_id": node_id,
        "run_id": run_id,
        "status": "idle",
    }
    document.update(fields)
    return document


def _run(run_id: str, **fields: Any) -> dict[str, Any]:
    document = {
        "_id": run_id,
        "command_id": f"cmd-{run_id}",
        "flow_run_id": run_id,
        "flow_task_id": f"task-{run_id}",
        "protocol_version": 2,
        "reply_queue": "reply",
        "run_id": run_id,
        "start_initialized": True,
        "status": "running",
        "updated_at": _ago(minutes=1),
    }
    document.update(fields)
    return document


@pytest.mark.asyncio
async def test_redelivery_keeps_command_id_and_a_second_start_does_not_create_a_run() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    redis = FakeRedis()
    payload = {
        "command_id": "cmd-start",
        "dag": {
            "edges": [{"source": "input", "target": "next"}],
            "nodes": [
                {"data": {"text": "hello"}, "id": "input", "type": "textInput"},
                {"id": "next", "type": "textInput"},
            ],
        },
        "end_ids": [],
        "flow_id": "flow-1",
        "flow_run_id": "run-1",
        "flow_run_type": "start",
        "flow_task_id": "task-1",
        "protocol_version": 2,
        "reply_queue": "reply",
        "start_ids": ["input"],
        "trace_id": "trace-1",
        "user_id": "user-1",
        "user_selection": {},
    }
    await FlowTask.run_flow(database, payload, publisher=publisher, redis_client=redis)

    inbox_collection = database[FlowCommandInboxService.COLLECTION]
    stored = inbox_collection.docs["cmd-start"]
    payload_hash = stored["payload_hash"]
    stored["lease_expires_at"] = _ago(seconds=30)
    stored["status"] = "processing"
    stored.pop("expires_at", None)
    stored.pop("redelivery_lease_expires_at", None)
    stored.pop("redelivery_lease_token", None)

    redelivered = await FlowRecoveryService.redeliver_due_workflow_commands(
        database,
        redis_client=redis,
    )

    assert redelivered == 1
    assert stored["command_id"] == "cmd-start"
    assert stored["payload_hash"] == payload_hash
    assert len(inbox_collection.docs) == 1
    queue_name, message = redis.messages[0]
    assert queue_name == "run_flow"
    decoded = decode_stream_payload(message)
    assert decoded["command_id"] == "cmd-start"
    assert decoded["flow_run_id"] == "run-1"

    await FlowTask.run_flow(database, decoded, publisher=publisher, redis_client=redis)

    runs = list(database[FlowRunStateService.COLLECTION].docs.values())
    assert len(runs) == 1
    assert runs[0]["run_id"] == "run-1"
    assert runs[0]["start_initialized"] is True
    assert inbox_collection.docs["cmd-start"]["command_id"] == "cmd-start"
    assert inbox_collection.docs["cmd-start"]["payload_hash"] == payload_hash


@pytest.mark.asyncio
async def test_redelivery_failure_does_not_mint_a_command_id() -> None:
    database = FakeDatabase()
    redis = FakeRedis()

    async def fail_xadd(queue_name: str, message: dict[str, Any]) -> str:
        del queue_name, message
        raise ConnectionError("redis down")

    redis.xadd = fail_xadd  # type: ignore[method-assign]
    await database[FlowCommandInboxService.COLLECTION].insert_one(
        {
            "_id": "cmd-fail",
            "command_id": "cmd-fail",
            "lease_expires_at": _ago(seconds=30),
            "payload_hash": "hash-1",
            "redelivery_payload": {"command_id": "cmd-fail", "flow_run_id": "run-fail"},
            "status": "processing",
        }
    )

    redelivered = await FlowRecoveryService.redeliver_due_workflow_commands(
        database,
        redis_client=redis,
    )

    stored = database[FlowCommandInboxService.COLLECTION].docs["cmd-fail"]
    assert redelivered == 0
    assert stored["command_id"] == "cmd-fail"
    assert stored["payload_hash"] == "hash-1"
    assert "redis down" in stored["redelivery_error"]
    assert len(database[FlowCommandInboxService.COLLECTION].docs) == 1


@pytest.mark.asyncio
async def test_webhook_timeout_uses_oc_ai_error_only_for_opencreator_ai() -> None:
    database = FakeDatabase()
    old = _ago(hours=2)
    fresh = datetime.now(UTC)
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-ai",
            "execution_mode": "webhook",
            "invocation_id": "inv-ai",
            "node_id": "model-ai",
            "result_id": "result-ai",
            "run_id": "run-ai",
            "status": "running",
            "updated_at": old,
            "vendor": "opencreator_ai",
        }
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-other",
            "execution_mode": "webhook",
            "invocation_id": "inv-other",
            "node_id": "model-other",
            "result_id": "result-other",
            "run_id": "run-other",
            "status": "submitting",
            "updated_at": old,
            "vendor": "mock",
        }
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-fresh",
            "execution_mode": "webhook",
            "invocation_id": "inv-fresh",
            "node_id": "model-fresh",
            "result_id": "result-fresh",
            "run_id": "run-fresh",
            "status": "running",
            "updated_at": fresh,
            "vendor": "opencreator_ai",
        }
    )

    count = await FlowRecoveryService.mark_timed_out_invocations(
        database,
        redis_client=None,
        publisher=FakePublisher(),
    )

    ai_invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-ai"}
    )
    other = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-other"}
    )
    fresh_invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-fresh"}
    )
    assert count == 2
    assert ai_invocation is not None
    assert ai_invocation["status"] == "timeout"
    assert ai_invocation["result_id"] == "result-ai"
    assert ai_invocation["error"]["error_code"] == OC_AI_WORKER_TIMEOUT_ERROR_CODE
    assert ai_invocation["error"]["origin"] == "oc-ai-worker"
    assert ai_invocation["error"]["phase"] == "callback_timeout"
    assert other is not None
    assert other["error"] == {"message": "webhook callback timeout"}
    assert fresh_invocation is not None
    assert fresh_invocation["status"] == "running"


@pytest.mark.asyncio
async def test_orphan_requeue_keeps_result_id_and_skips_cas_or_unplanned_nodes() -> None:
    database = FakeDatabase()
    stale_before = datetime.now(UTC) - timedelta(minutes=5)
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-orphan",
            "planned",
            execution_claim_token="claim-1",
            execution_plan_token="plan-1",
            execution_plans=[{"result_id": "result-1"}],
            expected_result_ids=["result-1"],
            started_at=_ago(minutes=10),
            status="running",
        )
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-orphan",
            "complete",
            execution_claim_token="claim-2",
            execution_plan_token="plan-2",
            execution_plans=[{"result_id": "result-2"}],
            expected_result_ids=["result-2"],
            started_at=_ago(minutes=10),
            status="running",
        )
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-2",
            "invocation_id": "inv-2",
            "node_id": "complete",
            "result_id": "result-2",
            "run_id": "run-orphan",
            "status": "running",
        }
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-orphan",
            "legacy",
            started_at=_ago(minutes=10),
            status="running",
        )
    )

    cas_failed = await FlowNodeStateService.requeue_orphaned_execution(
        database,
        run_id="run-orphan",
        node_id="planned",
        execution_plan_token="plan-1",
        execution_claim_token="stale-token",
        stale_before=datetime.now(UTC),
    )
    still_running = await FlowNodeStateService.get_node(database, "run-orphan", "planned")
    recovered = await FlowRecoveryService.recover_orphaned_planned_nodes(
        database,
        run_id="run-orphan",
        stale_before=stale_before,
    )

    planned = await FlowNodeStateService.get_node(database, "run-orphan", "planned")
    complete = await FlowNodeStateService.get_node(database, "run-orphan", "complete")
    legacy = await FlowNodeStateService.get_node(database, "run-orphan", "legacy")
    assert cas_failed is False
    assert still_running is not None
    assert still_running["status"] == "running"
    assert still_running["execution_claim_token"] == "claim-1"
    assert recovered == ["planned"]
    assert planned is not None
    assert planned["status"] == "queued"
    assert planned["expected_result_ids"] == ["result-1"]
    assert planned["execution_plans"] == [{"result_id": "result-1"}]
    assert "execution_claim_token" not in planned
    assert complete is not None
    assert complete["status"] == "running"
    assert complete["expected_result_ids"] == ["result-2"]
    assert legacy is not None
    assert legacy["status"] == "running"


@pytest.mark.asyncio
async def test_cas_failure_is_omitted_from_orphan_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-cas",
            "planned",
            execution_claim_token="claim-1",
            execution_plan_token="plan-1",
            execution_plans=[{"result_id": "result-keep"}],
            expected_result_ids=["result-keep"],
            started_at=_ago(minutes=10),
            status="running",
        )
    )

    async def refuse(*args: Any, **kwargs: Any) -> bool:
        del args, kwargs
        return False

    monkeypatch.setattr(FlowNodeStateService, "requeue_orphaned_execution", refuse)
    recovered = await FlowRecoveryService.recover_orphaned_planned_nodes(
        database,
        run_id="run-cas",
        stale_before=datetime.now(UTC),
    )

    node = await FlowNodeStateService.get_node(database, "run-cas", "planned")
    assert recovered == []
    assert node is not None
    assert node["expected_result_ids"] == ["result-keep"]
    assert node["status"] == "running"


@pytest.mark.asyncio
async def test_recover_running_skips_uninitialized_v2_and_returns_resumable_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()

    async def forbid_resume(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise AssertionError("recovery must not call handle_resume")

    monkeypatch.setattr(FlowResumeTask, "handle_resume", forbid_resume)
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-uninit", pending_resume=True, start_initialized=False)
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-other", flow_resume_queue="other-queue", pending_resume=True)
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-orphan", pending_resume=False)
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-orphan",
            "model",
            execution_claim_token="claim-1",
            execution_plan_token="plan-1",
            execution_plans=[{"result_id": "result-orphan"}],
            expected_result_ids=["result-orphan"],
            started_at=_ago(minutes=10),
            status="running",
        )
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-ready", pending_resume=False)
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node("run-ready", "input", status="idle")
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-done", pending_resume=False)
    )
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node("run-done", "input", status="success")
    )

    run_ids = await FlowRecoveryService.recover_running_flows(database)

    assert "run-uninit" not in run_ids
    assert "run-other" not in run_ids
    assert set(run_ids) == {"run-orphan", "run-ready", "run-done"}
    orphan = await FlowNodeStateService.get_node(database, "run-orphan", "model")
    ready = await FlowRunStateService.get_flow_run(database, "run-ready")
    done = await FlowRunStateService.get_flow_run(database, "run-done")
    assert orphan is not None
    assert orphan["status"] == "queued"
    assert orphan["expected_result_ids"] == ["result-orphan"]
    assert ready is not None
    assert ready["pending_resume"] is True
    assert done is not None
    assert done["pending_resume"] is True


@pytest.mark.asyncio
async def test_terminal_reconcile_query_requires_protocol_version_2() -> None:
    database = FakeDatabase()
    collection = database[FlowRunStateService.COLLECTION]
    queries: list[dict[str, Any]] = []
    original_find = collection.find

    def find(query: dict[str, Any]) -> Any:
        queries.append(query)
        return original_find(query)

    collection.find = find  # type: ignore[method-assign]
    await FlowRecoveryService.reconcile_terminal_flow_events(database, FakePublisher())

    assert queries
    assert queries[0]["protocol_version"] == 2
    assert queries[0]["status"]["$in"] == ["completed", "failed", "killed", "stopped", "success"]
    assert queries[0]["terminal_event_outbox_recorded"] == {"$ne": True}


@pytest.mark.asyncio
async def test_terminal_reconcile_reuses_event_id_and_skips_node_status() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-legacy", protocol_version=1, status="failed", start_initialized=True)
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-ok", status="completed", updated_at=_ago(minutes=2))
    )
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run("run-killed", status="killed", updated_at=_ago(minutes=1))
    )
    recorded_id = FlowEventPublishService.stable_event_id("finish_flow", "run-recorded")
    await database[FlowRunStateService.COLLECTION].insert_one(
        _run(
            "run-recorded",
            status="completed",
            terminal_event_id=recorded_id,
            terminal_event_outbox_recorded=True,
        )
    )

    first = await FlowRecoveryService.reconcile_terminal_flow_events(database, publisher)
    finish_id = FlowEventPublishService.stable_event_id("finish_flow", "run-ok")
    killed_id = FlowEventPublishService.stable_event_id("flow_killed", "run-killed")
    second = await FlowRecoveryService.reconcile_terminal_flow_events(database, publisher)

    outbox = list(database[FlowEventPublishService.COLLECTION].docs.values())
    event_types = {item["event_type"] for item in outbox}
    by_id = {item["event_id"]: item for item in outbox}
    recorded = await FlowRunStateService.get_flow_run(database, "run-ok")
    assert first == 2
    assert second == 0
    assert event_types == {"finish_flow", "flow_killed"}
    assert "node_status" not in event_types
    assert by_id[finish_id]["event_id"] == finish_id
    assert by_id[killed_id]["event_id"] == killed_id
    assert recorded is not None
    assert recorded["terminal_event_id"] == finish_id
    assert len(outbox) == 2

    await database[FlowRunStateService.COLLECTION].update_one(
        {"run_id": "run-ok"},
        {"$set": {"terminal_event_outbox_recorded": False}},
    )
    third = await FlowRecoveryService.reconcile_terminal_flow_events(database, publisher)
    outbox_after = list(database[FlowEventPublishService.COLLECTION].docs.values())
    assert third == 1
    assert len(outbox_after) == 2
    assert sum(item["event_id"] == finish_id for item in outbox_after) == 1


@pytest.mark.asyncio
async def test_pending_callback_replay_uses_finalizer_and_keeps_invocation_id() -> None:
    database = FakeDatabase()
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-cb",
            "external_task_id": "ai-1",
            "invocation_id": "result-1",
            "node_id": "model",
            "result_id": "result-1",
            "run_id": "run-cb",
            "status": "running",
            "vendor": "opencreator_ai",
        }
    )
    await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].insert_one(
        {
            "_id": "pending-1",
            "idempotency_key": "delivery-1",
            "payload": {
                "ai_task_id": "ai-1",
                "result": {"formatted_output": {"url": "done.png"}},
                "status": "success",
            },
            "status": "pending",
            "vendor": "opencreator_ai",
        }
    )

    replayed = await FlowRecoveryService.replay_pending_callbacks(
        database,
        redis_client=None,
        publisher=FakePublisher(),
    )

    pending = database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].docs["pending-1"]
    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "result-1"}
    )
    assert replayed == 1
    assert pending["status"] == "replayed"
    assert pending["invocation_id"] == "result-1"
    assert invocation is not None
    assert invocation["invocation_id"] == "result-1"
    assert invocation["result_id"] == "result-1"
    assert invocation["finalize_status"] == "done"
    assert database[FlowNodeStateService.COLLECTION].docs == {}


@pytest.mark.asyncio
async def test_pending_callback_replay_failure_marks_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = FakeDatabase()
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-cb",
            "invocation_id": "result-1",
            "node_id": "model",
            "result_id": "result-1",
            "run_id": "run-cb",
            "status": "submitting",
        }
    )
    await database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].insert_one(
        {
            "_id": "pending-1",
            "payload": {"ai_task_id": "ai-1", "status": "success"},
            "status": "pending",
            "vendor": "opencreator_ai",
        }
    )

    async def boom(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise RuntimeError("callback parse failed")

    monkeypatch.setattr(ModelInvocationService, "handle_callback_fast", boom)
    replayed = await FlowRecoveryService.replay_pending_callbacks(
        database,
        redis_client=None,
        publisher=FakePublisher(),
    )

    pending = database[ModelInvocationService.PENDING_CALLBACK_COLLECTION].docs["pending-1"]
    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "result-1"}
    )
    assert replayed == 0
    assert pending["status"] == "failed"
    assert invocation is not None
    assert invocation["status"] == "submitting"
    assert invocation["result_id"] == "result-1"


@pytest.mark.asyncio
async def test_stuck_running_finalize_is_forced_after_60_seconds() -> None:
    database = FakeDatabase()
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-old",
            "callback_status": "failed",
            "finalize_started_at": _ago(seconds=120),
            "finalize_status": "running",
            "invocation_id": "inv-old",
            "node_id": "model-old",
            "result_id": "result-old",
            "run_id": "run-old",
            "status": "running",
            "updated_at": _ago(seconds=120),
        }
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-new",
            "callback_status": "failed",
            "finalize_started_at": datetime.now(UTC),
            "finalize_status": "running",
            "invocation_id": "inv-new",
            "node_id": "model-new",
            "result_id": "result-new",
            "run_id": "run-new",
            "status": "running",
            "updated_at": datetime.now(UTC),
        }
    )

    recovered = await FlowRecoveryService.recover_stuck_finalize(
        database,
        redis_client=None,
        publisher=FakePublisher(),
    )

    old = await database[ModelInvocationService.COLLECTION].find_one({"invocation_id": "inv-old"})
    fresh = await database[ModelInvocationService.COLLECTION].find_one({"invocation_id": "inv-new"})
    assert recovered == 1
    assert old is not None
    assert old["finalize_status"] == "done"
    assert old["result_id"] == "result-old"
    assert fresh is not None
    assert fresh["finalize_status"] == "running"


@pytest.mark.asyncio
async def test_deduction_reconcile_confirms_usage_then_writes_the_same_result() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    await database[FlowRunStateService.COLLECTION].insert_one(_run("run-bill"))
    await database[FlowNodeStateService.COLLECTION].insert_one(
        _node(
            "run-bill",
            "model",
            expected_result_ids=["result-bill"],
            status="running",
            successors=[],
        )
    )
    await database[ModelInvocationService.COLLECTION].insert_one(
        {
            "_id": "inv-bill",
            "invocation_id": "inv-bill",
            "metadata": {"deduction": {"deduction_id": "deduction-1"}},
            "node_id": "model",
            "result": {"formatted_output": [{"url": "done.png"}]},
            "result_id": "result-bill",
            "run_id": "run-bill",
            "status": "success",
            "user_id": "user-1",
        }
    )
    await database["usage_v2"].insert_one(
        {
            "_id": "deduction-1",
            "deduction_id": "deduction-1",
            "deduction_status": "deducted",
        }
    )

    count = await FlowRecoveryService.reconcile_pending_deductions(
        database,
        redis_client=None,
        publisher=publisher,
    )

    invocation = await database[ModelInvocationService.COLLECTION].find_one(
        {"invocation_id": "inv-bill"}
    )
    usage = await database["usage_v2"].find_one({"deduction_id": "deduction-1"})
    node = await FlowNodeStateService.get_node(database, "run-bill", "model")
    outbox = list(database[FlowEventPublishService.COLLECTION].docs.values())
    assert count == 1
    assert invocation is not None
    assert invocation["usage_status"] == "confirmed"
    assert invocation["result_id"] == "result-bill"
    assert usage is not None
    assert usage["deduction_status"] == "deducted"
    assert len(database["usage_v2"].docs) == 1
    assert node is not None
    assert node["status"] == "success"
    assert [item["event_type"] for item in outbox] == ["node_status"]
    assert outbox[0]["event"]["payload"]["node_id"] == "model"


@pytest.mark.asyncio
async def test_due_outbox_replay_keeps_the_original_event_id() -> None:
    database = FakeDatabase()
    publisher = FakePublisher()
    event_id = "wfe_original"
    await database[FlowEventPublishService.COLLECTION].insert_one(
        {
            "_id": event_id,
            "event": {"event_id": event_id, "event_type": "finish_flow"},
            "event_id": event_id,
            "event_type": "finish_flow",
            "next_attempt_at": _ago(seconds=5),
            "payload": {"event_id": event_id, "event_type": "finish_flow"},
            "queue_name": "reply",
            "status": "failed",
        }
    )

    replayed = await FlowRecoveryService.replay_due_outbox_events(database, publisher)
    again = await FlowRecoveryService.replay_failed_outbox_events(database, publisher)

    stored = database[FlowEventPublishService.COLLECTION].docs[event_id]
    assert replayed == 1
    assert again == 0
    assert stored["event_id"] == event_id
    assert stored["status"] == "sent"
    assert len(database[FlowEventPublishService.COLLECTION].docs) == 1
    assert publisher.messages[0]["payload"]["event_id"] == event_id
    assert json.dumps(publisher.messages[0]["payload"]).count(event_id) >= 1
