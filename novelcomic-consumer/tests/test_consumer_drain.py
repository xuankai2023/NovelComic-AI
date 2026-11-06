import asyncio
from typing import Any

import pytest
from test_health import FakeDatabase, FakeRedis, client

from app.config import get_settings
from app.tasks.flow import FlowStreamWorker, FlowTask
from app.tasks.flow_maintenance import MaintenanceStreamWorker
from app.utils.drainable_consumer import (
    INTAKE_ACTIVE,
    INTAKE_DRAINING,
    INTAKE_STOPPED,
    DrainableRedisStreamConsumer,
    inflight_key,
    intake_key,
)


class MemoryRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self.reads: list[str] = []
        self.acks: list[object] = []
        self.groups: list[str] = []
        self.batches: list[list[tuple[str, list[tuple[str, dict[str, str]]]]]] = []

    async def setex(self, key: str, ttl: int, value: object) -> bool:
        self.values[f"ttl:{key}"] = ttl
        self.values[key] = value
        return True

    async def sadd(self, key: str, member: str) -> int:
        bucket = self.sets.setdefault(key, set())
        before = len(bucket)
        bucket.add(member)
        return len(bucket) - before

    async def srem(self, key: str, member: str) -> int:
        bucket = self.sets.setdefault(key, set())
        if member not in bucket:
            return 0
        bucket.remove(member)
        return 1

    async def xgroup_create(self, stream: str, group: str, **kwargs: Any) -> None:
        del kwargs
        self.groups.append(f"{stream}:{group}")

    async def xreadgroup(
        self,
        group: str,
        consumer: str,
        streams: dict[str, str],
        **kwargs: Any,
    ) -> list[Any]:
        del group, consumer, kwargs
        stream_name = next(iter(streams))
        self.reads.append(stream_name)
        if self.batches:
            return self.batches.pop(0)
        return []

    async def xack(self, stream: str, group: str, message_id: object) -> int:
        del stream, group
        self.acks.append(message_id)
        return 1


def _consumer(redis: MemoryRedis, *, instance_id: str = "blue") -> DrainableRedisStreamConsumer:
    consumer = DrainableRedisStreamConsumer(
        redis,
        instance_id=instance_id,
        queue_name="run_flow",
        group="novelcomic_consumer_group",
        consumer_name="consumer",
    )
    consumer.draining_pause_seconds = 0
    consumer.stopped_pause_seconds = 0
    return consumer


@pytest.mark.asyncio
async def test_startup_resets_stopped_and_keeps_draining() -> None:
    redis = MemoryRedis()
    stopped = _consumer(redis)
    redis.values[intake_key("blue")] = "STOPPED"
    assert await stopped.startup() == INTAKE_ACTIVE
    assert redis.values[intake_key("blue")] == INTAKE_ACTIVE

    redis.values[intake_key("blue")] = INTAKE_DRAINING
    assert await _consumer(redis).startup() == INTAKE_DRAINING
    assert redis.values[intake_key("blue")] == INTAKE_DRAINING


@pytest.mark.asyncio
async def test_draining_skips_run_flow_until_inflight_is_empty() -> None:
    redis = MemoryRedis()
    consumer = _consumer(redis)
    redis.values[intake_key("blue")] = INTAKE_DRAINING
    redis.sets[inflight_key("blue")] = {"1-0"}

    assert await consumer.read_once() == []
    assert redis.reads == []
    assert redis.values[intake_key("blue")] == INTAKE_DRAINING

    redis.sets[inflight_key("blue")] = set()
    assert await consumer.read_once() == []
    assert redis.values[intake_key("blue")] == INTAKE_STOPPED
    assert redis.reads == []


@pytest.mark.asyncio
async def test_active_restores_run_flow_reads() -> None:
    redis = MemoryRedis()
    consumer = _consumer(redis)
    redis.values[intake_key("blue")] = INTAKE_ACTIVE
    redis.batches.append([("run_flow", [("9-0", {"payload": "{}"})])])

    messages = await consumer.read_once()

    assert redis.reads == ["run_flow"]
    assert messages[0][1][0][0] == "9-0"
    assert redis.values["ttl:" + consumer.heartbeat_key] == 30


@pytest.mark.asyncio
async def test_run_flow_inflight_is_added_and_removed(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = MemoryRedis()
    redis.batches.append([("run_flow", [("4-0", {"payload": "{}", "flow_task_id": "task"})])])
    seen: list[set[str]] = []

    async def fake_run_flow(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        seen.append(set(redis.sets[inflight_key("blue")]))

    monkeypatch.setattr(get_settings(), "consumer_instance_id", "blue")
    monkeypatch.setattr(FlowTask, "run_flow", staticmethod(fake_run_flow))
    worker = FlowStreamWorker(database=object(), redis_client=redis, publisher=object())
    worker.intake.draining_pause_seconds = 0
    worker.intake.stopped_pause_seconds = 0

    async def stop_after_read(*args: Any, **kwargs: Any) -> list[Any]:
        messages = await DrainableRedisStreamConsumer.read_once(worker.intake, *args, **kwargs)
        if messages:
            worker.stop()
        elif redis.acks:
            worker.stop()
        return messages

    worker.intake.read_once = stop_after_read  # type: ignore[method-assign]
    await worker.run()

    assert seen == [{"4-0"}]
    assert redis.sets[inflight_key("blue")] == set()
    assert redis.acks == ["4-0"]


@pytest.mark.asyncio
async def test_maintenance_still_reads_while_run_flow_is_draining() -> None:
    redis = MemoryRedis()
    redis.values[intake_key("blue")] = INTAKE_DRAINING
    redis.sets[inflight_key("blue")] = {"1-0"}
    run_flow = _consumer(redis)
    assert await run_flow.read_once() == []

    maintenance = MaintenanceStreamWorker(
        database=object(),
        redis_client=redis,
        publisher=object(),
    )

    async def read_once_and_stop(*args: Any, **kwargs: Any) -> list[Any]:
        result = await MemoryRedis.xreadgroup(redis, *args, **kwargs)
        maintenance.stop()
        return result

    redis.xreadgroup = read_once_and_stop  # type: ignore[method-assign]
    await asyncio.wait_for(maintenance.run(), timeout=1)

    assert redis.reads == ["flow_maintenance"]


def test_drain_and_active_change_intake(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "consumer_instance_id", "blue")
    redis = FakeRedis()
    app_client = client(redis, FakeDatabase())

    drained = app_client.post("/ops/consumer/drain")
    ready = app_client.get("/readyz")
    assert drained.status_code == 200
    assert drained.json() == {"status": "draining", "instance_id": "blue"}
    assert redis.values[intake_key("blue")] == "DRAINING"
    assert ready.status_code == 503

    resumed = app_client.post("/ops/consumer/active")
    assert resumed.status_code == 200
    assert resumed.json() == {"status": "active", "instance_id": "blue"}
    assert redis.values[intake_key("blue")] == "ACTIVE"
    assert app_client.get("/readyz").status_code == 200
