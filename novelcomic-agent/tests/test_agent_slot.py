from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from novelcomic_agent.api.server import (
    SlotTiming,
    _running_run_tasks,
    heartbeat_loop,
    make_instance_id,
    orphan_scan_loop,
    scan_orphaned_runs,
    stop_agent_slot,
)
from novelcomic_agent.config import Settings
from novelcomic_agent.main import create_app
from novelcomic_agent.services.agent_redis_run_store import RedisRunStore


class MemoryRedis:
    def __init__(self) -> None:
        self.strings: dict[str, Any] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.sets: dict[str, set[str]] = {}
        self.expires: dict[str, int] = {}

    async def set(
        self,
        key: str,
        value: Any,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        if nx and key in self.strings:
            return None
        self.strings[key] = value
        if ex is not None:
            self.expires[key] = ex
        return True

    async def get(self, key: str) -> Any:
        return self.strings.get(key)

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if self.strings.pop(key, None) is not None or self.hashes.pop(key, None) is not None:
                removed += 1
        return removed

    async def exists(self, key: str) -> int:
        return 1 if key in self.strings or key in self.hashes else 0

    async def expire(self, key: str, seconds: int) -> bool:
        self.expires[key] = seconds
        return True

    async def hset(
        self,
        key: str,
        field: str | None = None,
        value: Any = None,
        mapping: dict[str, Any] | None = None,
    ) -> int:
        bucket = self.hashes.setdefault(key, {})
        if mapping:
            for item_field, item_value in mapping.items():
                bucket[str(item_field)] = str(item_value)
            return len(mapping)
        if field is not None:
            bucket[str(field)] = "" if value is None else str(value)
            return 1
        return 0

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    async def sadd(self, key: str, *members: str) -> int:
        bucket = self.sets.setdefault(key, set())
        before = len(bucket)
        bucket.update(members)
        return len(bucket) - before

    async def srem(self, key: str, *members: str) -> int:
        bucket = self.sets.setdefault(key, set())
        before = len(bucket)
        bucket.difference_update(members)
        return before - len(bucket)

    async def smembers(self, key: str) -> set[str]:
        return set(self.sets.get(key, set()))

    async def xadd(
        self,
        key: str,
        fields: dict[str, Any],
        maxlen: int | None = None,
        approximate: bool = False,
    ) -> str:
        del key, fields, maxlen, approximate
        return "1-0"


def _app(redis: MemoryRedis, instance_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        state=SimpleNamespace(
            dependencies=SimpleNamespace(redis=redis),
            instance_id=instance_id,
            shutting_down=False,
            resume_agent_run=None,
            agent_slot=None,
        )
    )


async def _seed_running_run(store: RedisRunStore, redis: MemoryRedis, *, owner: str) -> None:
    await redis.hset(
        store.meta_key("run-1"),
        mapping={
            "status": "running",
            "owner_instance": owner,
            "session_id": "sess-1",
            "user_id": "user-1",
        },
    )
    await store.add_active_run("run-1")
    await store.write_checkpoint(
        "run-1",
        {
            "run_id": "run-1",
            "message": "keep going",
            "session_id": "sess-1",
            "user_id": "user-1",
            "client_request_id": "req-1",
        },
    )
    await store.refresh_instance_heartbeat(owner, ttl_seconds=10)


def test_slot_clocks_and_instance_id() -> None:
    timing = SlotTiming()
    assert timing.heartbeat_interval == 3
    assert timing.heartbeat_ttl == 10
    assert timing.scan_initial_delay == 15
    assert timing.scan_interval == 10
    assert timing.drain_timeout == 90
    prefix, _, suffix = make_instance_id().partition("_")
    assert prefix.isdigit()
    assert len(suffix) == 8


async def test_heartbeat_refreshes_until_shutting_down() -> None:
    refreshes: list[tuple[str, int]] = []

    class Store:
        async def refresh_instance_heartbeat(self, instance_id: str, ttl_seconds: int = 10) -> None:
            refreshes.append((instance_id, ttl_seconds))
            if len(refreshes) == 2:
                app.state.shutting_down = True

    app = SimpleNamespace(state=SimpleNamespace(shutting_down=False))
    await heartbeat_loop(app, Store(), "111_abcd1234", interval=0.01, ttl=10)

    assert refreshes == [("111_abcd1234", 10), ("111_abcd1234", 10)]


async def test_scan_waits_before_the_first_pass() -> None:
    calls: list[float] = []

    class Store:
        async def get_active_runs(self) -> set[str]:
            calls.append(time.monotonic())
            app.state.shutting_down = True
            return set()

    app = SimpleNamespace(state=SimpleNamespace(shutting_down=False, instance_id="222_abcd1234"))
    started = time.monotonic()
    await orphan_scan_loop(app, Store(), initial_delay=0.05, interval=0.01)  # type: ignore[arg-type]

    assert len(calls) == 1
    assert calls[0] - started >= 0.04


async def test_scan_skips_a_live_owner_and_interrupts_without_checkpoint() -> None:
    redis = MemoryRedis()
    store = RedisRunStore(redis)
    owner = "111_deadbeef"
    await _seed_running_run(store, redis, owner=owner)
    resumed: list[str] = []

    async def hook(run_id: str, checkpoint: dict[str, Any]) -> None:
        del checkpoint
        resumed.append(run_id)

    app = _app(redis, "222_cafebabe")
    app.state.resume_agent_run = hook
    await scan_orphaned_runs(app, store)
    assert resumed == []
    assert await store.read_checkpoint("run-1") is not None

    await redis.delete(store.instance_heartbeat_key(owner))
    await redis.delete(store.checkpoint_key("run-1"))
    await scan_orphaned_runs(app, store)

    assert resumed == []
    assert (await store.get_run_meta("run-1"))["status"] == "interrupted"
    assert "run-1" not in await store.get_active_runs()


async def test_shutdown_keeps_checkpoint_for_the_other_slot() -> None:
    _running_run_tasks.clear()
    redis = MemoryRedis()
    store = RedisRunStore(redis)
    other = RedisRunStore(redis)
    owner = "111_deadbeef"
    await _seed_running_run(store, redis, owner=owner)
    app = _app(redis, owner)

    async def hang() -> None:
        await asyncio.Event().wait()

    from novelcomic_agent.api.server import _track_run_task

    _track_run_task(app, store, "run-1", hang())
    await asyncio.sleep(0)
    await stop_agent_slot(app, drain_timeout=0)

    kept = await other.read_checkpoint("run-1")
    assert kept is not None
    assert json.loads(redis.strings[store.checkpoint_key("run-1")])["message"] == "keep going"
    assert "run-1" in await other.get_active_runs()

    await redis.delete(store.instance_heartbeat_key(owner))
    seen: list[dict[str, Any]] = []

    async def hook(run_id: str, checkpoint: dict[str, Any]) -> None:
        del checkpoint
        loaded = await other.read_checkpoint(run_id)
        assert loaded is not None
        seen.append(loaded)

    takeover = _app(redis, "222_cafebabe")
    takeover.state.resume_agent_run = hook
    await scan_orphaned_runs(takeover, other)
    await asyncio.sleep(0)
    try:
        assert seen and seen[0]["message"] == "keep going"
        assert (await other.get_run_meta("run-1"))["owner_instance"] == "222_cafebabe"
    finally:
        for task in list(_running_run_tasks.values()):
            task.cancel()
        await asyncio.gather(*_running_run_tasks.values(), return_exceptions=True)
        _running_run_tasks.clear()


class _FakeDependencies:
    def __init__(self) -> None:
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True

    async def check_all(self) -> dict[str, dict[str, str]]:
        return {"redis": {"status": "ok"}}


def test_local_drain_rejects_new_runs_and_health_stays_ok() -> None:
    app = create_app(Settings(), dependency_manager=_FakeDependencies())  # type: ignore[arg-type]
    with TestClient(app, client=("127.0.0.1", 50000)) as local:
        drained = local.post("/preview/drain")
        rejected = local.post(
            "/v1/agent/runs",
            json={"message": "hello", "session_id": "sess-1"},
        )
        health = local.get("/health")
    with TestClient(app, client=("10.1.2.3", 50000)) as remote:
        denied = remote.post("/preview/drain")

    assert drained.status_code == 200
    assert rejected.status_code == 503
    assert rejected.json()["detail"]["code"] == "INSTANCE_SHUTTING_DOWN"
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert denied.status_code == 404
