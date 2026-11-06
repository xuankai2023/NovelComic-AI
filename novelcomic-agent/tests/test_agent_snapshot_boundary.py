from __future__ import annotations

from pathlib import Path

import pytest

from novelcomic_agent.core.tools.workflow_snapshot import (
    apply_request_workflow_snapshot,
    normalize_request_workflow_snapshot,
    workflow_data_from_snapshot,
    workflow_snapshot_from_context,
)
from novelcomic_agent.services.agent_redis_run_store import (
    RedisRunStore,
    ResumeWindowExpiredError,
)

ROOT = Path(__file__).resolve().parents[1]
CONSUMER_FIELDS = (
    "protocol_version",
    "flow_task_id",
    "flow_run_state",
    "flow_node_state",
    "last_event_id",
)


def _canvas_snapshot(**overrides: object) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "flow_id": "flow-1",
        "schema_version": 2,
        "snapshot_hash": "hash-1",
        "captured_at_utc_ms": 1_700_000_000_000,
        "nodes": [{"id": "n1"}],
        "edges": [],
    }
    snapshot.update(overrides)
    return snapshot


def _consumer_snapshot() -> dict[str, object]:
    return {
        "protocol_version": 2,
        "flow_task_id": "task-1",
        "flow_run_id": "run-1",
        "status": "running",
        "last_event_id": "wfe_1",
        "flow_task": {"flow_task_id": "task-1"},
        "flow_run_state": {"status": "running"},
        "flow_node_state": [{"node_id": "n1", "status": "RUNNING"}],
    }


def _is_consumer_v2_snapshot(snapshot: object) -> bool:
    return (
        isinstance(snapshot, dict)
        and snapshot.get("protocol_version") == 2
        and isinstance(snapshot.get("flow_task_id"), str)
        and bool(snapshot.get("flow_task_id"))
    )


class _StreamRedis:
    def __init__(self, entries: list[tuple[str, dict[str, str]]]) -> None:
        self.entries = entries
        self.calls: list[str] = []

    async def xrange(self, key: str, count: int = 1) -> list[tuple[str, dict[str, str]]]:
        self.calls.append(f"xrange:{key}:{count}")
        return self.entries[:count]

    def __getattr__(self, name: str):
        async def forbidden(*_args: object, **_kwargs: object) -> None:
            raise AssertionError(name)

        return forbidden


def test_missing_snapshot_hash_returns_empty() -> None:
    raw = _canvas_snapshot()
    raw.pop("snapshot_hash")

    assert normalize_request_workflow_snapshot(raw, "flow-1") is None
    blank_hash = _canvas_snapshot(snapshot_hash="  ")
    other_flow = _canvas_snapshot(flow_id="other")
    assert normalize_request_workflow_snapshot(blank_hash, "flow-1") is None
    assert normalize_request_workflow_snapshot(other_flow, "flow-1") is None
    snapshot, reason = workflow_snapshot_from_context(
        {"workflow_snapshot": raw},
        "flow-1",
    )
    assert snapshot is None
    assert reason == "missing_snapshot_hash"


def test_request_snapshot_and_consumer_snapshot_do_not_substitute() -> None:
    consumer = _consumer_snapshot()
    assert normalize_request_workflow_snapshot(consumer, "flow-1") is None
    assert _is_consumer_v2_snapshot(consumer) is True

    mixed = _canvas_snapshot(
        protocol_version=2,
        flow_task_id="task-1",
        flow_run_state={"status": "running"},
        flow_node_state=[{"node_id": "n1", "status": "RUNNING"}],
        last_event_id="wfe_1",
    )
    normalized = normalize_request_workflow_snapshot(mixed, "flow-1")
    assert normalized is not None
    assert normalized["nodes"] == [{"id": "n1"}]
    assert normalized["edges"] == []
    for field in CONSUMER_FIELDS:
        assert field not in normalized
    assert _is_consumer_v2_snapshot(normalized) is False

    adapted = workflow_data_from_snapshot(normalized, "flow-1")
    assert adapted == {"flow_id": "flow-1", "nodes": [{"id": "n1"}], "edges": []}
    assert "flow_run_state" not in adapted


def test_apply_request_snapshot_drops_invalid_canvas_from_payload() -> None:
    payload = {
        "message": "hi",
        "metadata": {"workflow_snapshot": _consumer_snapshot()},
        "workflow_snapshot": _canvas_snapshot(snapshot_hash=""),
    }

    assert apply_request_workflow_snapshot(payload, "flow-1") is None
    assert payload["workflow_snapshot"] is None
    assert "workflow_snapshot" not in payload["metadata"]


def test_agent_recovery_files_do_not_call_canvas_recovery() -> None:
    paths = (
        "src/novelcomic_agent/services/agent_redis_run_store.py",
        "src/novelcomic_agent/core/tools/workflow_snapshot.py",
        "src/novelcomic_agent/api/server.py",
    )
    for relative in paths:
        text = ROOT.joinpath(relative).read_text()
        assert "FlowRecoveryService" not in text
        assert "/api/internal/workflow" not in text
    server = ROOT.joinpath("src/novelcomic_agent/api/server.py").read_text()
    assert "apply_request_workflow_snapshot" in server


@pytest.mark.asyncio
async def test_ensure_resume_available_checks_only_the_agent_stream() -> None:
    redis = _StreamRedis([("10-0", {"event": "agent.started"})])
    store = RedisRunStore(redis)

    await store.ensure_resume_available("run-1", last_event_id="0-0")
    assert redis.calls == []

    await store.ensure_resume_available("run-1", last_event_id="10-0")
    assert redis.calls == ["xrange:agent:run:run-1:events:1"]

    with pytest.raises(ResumeWindowExpiredError) as caught:
        await store.ensure_resume_available("run-1", last_event_id="9-0")
    assert caught.value.run_id == "run-1"
    assert caught.value.last_event_id == "9-0"
    assert caught.value.earliest_event_id == "10-0"
    assert redis.calls == [
        "xrange:agent:run:run-1:events:1",
        "xrange:agent:run:run-1:events:1",
    ]
