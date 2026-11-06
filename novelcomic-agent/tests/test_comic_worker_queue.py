"""Outbox publication and stage B worker dispatch."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import aio_pika
import pytest

from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.queue.outbox_publisher import OutboxPublisher
from novelcomic_agent.comic.queue.rabbit_broker import WORKER_QUEUE, RabbitWorkerBroker
from novelcomic_agent.comic.queue.worker_consumer import WorkerConsumer
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.wiring import build_stage_b
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    page_png,
    production_request,
    tenant_from_header,
)
from tests.test_comic_job_lease import ManualClock

HOSTS = frozenset({"cdn.example", "objects.novelcomic.local"})


class RecordingQueue:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.bodies: list[dict[str, object]] = []

    async def publish(self, body: dict[str, object]) -> None:
        if self.fail:
            raise ConnectionError("broker down")
        self.bodies.append(body)

    async def consume(self, handler) -> None:
        del handler

    async def aclose(self) -> None:
        return None


class Spy:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def run(self, production_id: str) -> None:
        self.calls.append(production_id)


def _publisher(clock: ManualClock, queue: RecordingQueue) -> tuple[OutboxPublisher, MemoryLedger]:
    ledger = MemoryLedger(clock)
    return OutboxPublisher(ledger, queue, owner="publisher", clock=clock), ledger


async def _append(ledger: MemoryLedger, event_id: str = "evt-1") -> None:
    from novelcomic_agent.comic.queue.ledger_queue import LedgerOutboxRepository
    from novelcomic_agent.comic.queue.outbox_repository import NewOutboxEvent

    await LedgerOutboxRepository(ledger).append(
        NewOutboxEvent(
            event_id=event_id,
            aggregate_id="prod_1",
            type="comic.worker",
            payload={"worker": "analyze", "productionId": "prod_1", "state": "CREATED"},
        )
    )


async def test_publisher_confirms_then_marks_and_restart_survives_a_lost_lease() -> None:
    clock = ManualClock()
    queue = RecordingQueue()
    publisher, ledger = _publisher(clock, queue)
    await _append(ledger)
    from novelcomic_agent.comic.queue.ledger_queue import LedgerOutboxRepository

    outbox = LedgerOutboxRepository(ledger)
    held = await outbox.claim(owner="dead-process", limit=10, lease_seconds=30)
    assert [event.event_id for event in held] == ["evt-1"]
    assert await publisher.publish_available() == 0
    assert queue.bodies == []

    clock.now += timedelta(seconds=31)
    assert await publisher.publish_available() == 1
    message = queue.bodies[0]
    assert message["eventId"] == "evt-1"
    assert message["type"] == "comic.worker"
    assert message["worker"] == "analyze"
    assert message["productionId"] == "prod_1"
    assert await publisher.publish_available() == 0


async def test_publish_failure_releases_until_the_backoff_elapses() -> None:
    clock = ManualClock()
    queue = RecordingQueue(fail=True)
    publisher, ledger = _publisher(clock, queue)
    await _append(ledger)
    with pytest.raises(ConnectionError, match="broker down"):
        await publisher.publish_available()
    queue.fail = False
    assert await publisher.publish_available() == 0
    clock.now += timedelta(seconds=3)
    assert await publisher.publish_available() == 1


async def test_duplicate_delivery_does_not_bill_voice_or_render_again() -> None:
    image = page_png("page-body")
    remotion = ScriptedRemotion()
    speech = ScriptedSpeech()
    detector = ScriptedDetector()
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=detector,
        speech=speech,
        fetcher=MemoryFetcher({"https://cdn.example/page-1.png": image}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
    )
    accepted = await runtime.service.accept("tenant-a", production_request())
    consumer = WorkerConsumer(
        analyze=runtime.analyze.run,
        voice=runtime.voice.run,
        render=runtime.render.run,
        productions=runtime.productions,
    )
    message = {
        "worker": "analyze",
        "productionId": accepted.production_id,
        "eventId": "evt-analyze",
        "type": "comic.worker",
    }
    assert await consumer.handle(message) == "ack"
    assert await consumer.handle(message) == "ack"
    assert detector.calls == 1

    voice = {**message, "worker": "voice", "eventId": "evt-voice"}
    assert await consumer.handle(voice) == "ack"
    billed = speech.calls
    assert billed == 1
    assert await consumer.handle(voice) == "ack"
    assert speech.calls == billed

    render = {**message, "worker": "render", "eventId": "evt-render"}
    assert await consumer.handle(render) == "ack"
    row = await runtime.productions.get_row(accepted.production_id)
    assert row.state == ProductionState.DELIVERED.value
    assert remotion.render_batch_calls == 1
    cost = row.actual_cost_fen
    assert await consumer.handle(render) == "ack"
    again = await runtime.productions.get_row(accepted.production_id)
    assert again.state == ProductionState.DELIVERED.value
    assert again.actual_cost_fen == cost
    assert remotion.render_batch_calls == 1
    assert speech.calls == billed


async def test_preparing_assets_uses_the_layer_worker_when_it_is_bound() -> None:
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({"https://cdn.example/page-1.png": page_png("page-body")}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
    )
    accepted = await runtime.service.accept("tenant-a", production_request())
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    assert row.state == ProductionState.PREPARING_ASSETS.value
    assets = Spy()
    render = Spy()
    consumer = WorkerConsumer(
        analyze=assets.run,
        voice=assets.run,
        render=render.run,
        productions=runtime.productions,
        assets=assets.run,
    )
    message = {
        "worker": "render",
        "productionId": accepted.production_id,
        "eventId": "evt-assets",
        "type": "comic.worker",
    }
    assert await consumer.handle(message) == "requeue"
    assert assets.calls == [accepted.production_id]
    assert render.calls == []


async def test_none_preview_and_errors_follow_the_stage_b_dispatch_rules(
    caplog: pytest.LogCaptureFixture,
) -> None:
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
    )
    accepted = await runtime.service.accept("tenant-a", production_request())
    analyze = Spy()
    consumer = WorkerConsumer(
        analyze=analyze.run,
        voice=analyze.run,
        render=analyze.run,
        productions=runtime.productions,
    )
    base = {
        "productionId": accepted.production_id,
        "eventId": "evt-none",
        "type": "comic.worker",
    }
    assert await consumer.handle({**base, "worker": "none"}) == "ack"
    row = await runtime.productions.get_row(accepted.production_id)
    assert row.state == ProductionState.CREATED.value
    assert analyze.calls == []

    with caplog.at_level("ERROR"):
        assert await consumer.handle({**base, "worker": "preview"}) == "ack"
        assert await consumer.handle({**base, "worker": "package"}) == "ack"
    assert "preview" in caplog.text
    assert "package" in caplog.text
    assert analyze.calls == []
    assert (await runtime.productions.get_row(accepted.production_id)).state == "CREATED"

    class Boom:
        def __init__(self, *, retryable: bool) -> None:
            self.retryable = retryable

        async def run(self, production_id: str) -> None:
            del production_id
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "provider timed out" if self.retryable else "bad page",
                retryable=self.retryable,
            )

    retrying = WorkerConsumer(
        analyze=Boom(retryable=True).run,
        voice=analyze.run,
        render=analyze.run,
        productions=runtime.productions,
    )
    assert await retrying.handle({**base, "worker": "analyze"}) == "requeue"
    assert (await runtime.productions.get_row(accepted.production_id)).last_error_code is None

    stopping = WorkerConsumer(
        analyze=Boom(retryable=False).run,
        voice=analyze.run,
        render=analyze.run,
        productions=runtime.productions,
    )
    assert await stopping.handle({**base, "worker": "analyze"}) == "ack"
    failed = await runtime.productions.get_row(accepted.production_id)
    assert failed.state == ProductionState.CREATED.value
    assert failed.last_error_code == "COMPOSE_FAILED"


async def test_unfinished_worker_is_requeued_without_a_second_state_change() -> None:
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
    )
    accepted = await runtime.service.accept("tenant-a", production_request())
    idle = Spy()
    consumer = WorkerConsumer(
        analyze=idle.run,
        voice=idle.run,
        render=idle.run,
        productions=runtime.productions,
    )
    decision = await consumer.handle(
        {
            "worker": "analyze",
            "productionId": accepted.production_id,
            "eventId": "evt-poll",
            "type": "comic.worker",
        }
    )
    assert decision == "requeue"
    assert idle.calls == [accepted.production_id]
    assert (await runtime.productions.get_row(accepted.production_id)).state == "CREATED"


class _Exchange:
    def __init__(self) -> None:
        self.messages: list[tuple[object, str]] = []

    async def publish(self, message: object, routing_key: str) -> None:
        self.messages.append((message, routing_key))


class _Queue:
    def __init__(self) -> None:
        self.callback = None
        self.cancelled = False

    async def consume(self, callback, **kwargs):
        del kwargs
        self.callback = callback
        return "tag-1"

    async def cancel(self, consumer_tag: str) -> None:
        assert consumer_tag == "tag-1"
        self.cancelled = True


class _Channel:
    def __init__(self) -> None:
        self.exchange = _Exchange()
        self.queue = _Queue()
        self.prefetch = None
        self.declared: tuple[str, bool] | None = None
        self.closed = False

    def __await__(self):
        async def _open() -> _Channel:
            return self

        return _open().__await__()

    async def set_qos(self, prefetch_count: int = 0, **kwargs) -> None:
        del kwargs
        self.prefetch = prefetch_count

    async def declare_queue(self, name: str, *, durable: bool = False, **kwargs):
        del kwargs
        self.declared = (name, durable)
        return self.queue

    async def close(self) -> None:
        self.closed = True

    @property
    def default_exchange(self) -> _Exchange:
        return self.exchange


class _Connection:
    def __init__(self, channel: _Channel) -> None:
        self.channel_obj = channel
        self.confirms: bool | None = None

    def channel(self, publisher_confirms: bool = True, **kwargs):
        del kwargs
        self.confirms = publisher_confirms
        return self.channel_obj


class _Incoming:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.acked = False
        self.requeue: bool | None = None

    async def ack(self, multiple: bool = False) -> None:
        del multiple
        self.acked = True

    async def nack(self, multiple: bool = False, requeue: bool = True) -> None:
        del multiple
        self.requeue = requeue


async def test_rabbit_queue_is_durable_and_redelivers_retryable_work() -> None:
    channel = _Channel()
    connection = _Connection(channel)
    broker = await RabbitWorkerBroker.connect(connection, requeue_delay_seconds=0)  # type: ignore[arg-type]
    assert connection.confirms is True
    assert channel.declared == (WORKER_QUEUE, True)
    await broker.publish({"worker": "analyze", "eventId": "evt-1", "type": "comic.worker"})
    message, routing_key = channel.exchange.messages[0]
    assert routing_key == WORKER_QUEUE
    assert isinstance(message, aio_pika.Message)
    assert message.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
    assert json.loads(message.body.decode())["worker"] == "analyze"

    async def handler(body: dict[str, object]) -> str:
        return "requeue" if body.get("worker") == "analyze" else "ack"

    await broker.consume(handler)
    retry = _Incoming(message.body)
    await channel.queue.callback(retry)  # type: ignore[misc]
    assert retry.acked is False
    assert retry.requeue is True

    done = _Incoming(b'{"worker":"none"}')
    await channel.queue.callback(done)  # type: ignore[misc]
    assert done.acked is True

    garbage = _Incoming(b"not-json")
    await channel.queue.callback(garbage)  # type: ignore[misc]
    assert garbage.acked is True

    await broker.aclose()
    assert channel.queue.cancelled is True
    assert channel.closed is True


async def test_live_rabbit_confirms_a_persistent_worker_message() -> None:
    from novelcomic_agent.config import Settings

    event_id = f"evt-live-{uuid4().hex}"
    try:
        connection = await asyncio.wait_for(
            aio_pika.connect_robust(Settings().rabbitmq_url),
            timeout=3,
        )
    except Exception as exc:
        pytest.skip(f"RabbitMQ is not available: {type(exc).__name__}")
    broker = await RabbitWorkerBroker.connect(connection, requeue_delay_seconds=0)
    seen: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()

    async def handler(body: dict[str, object]) -> str:
        if body.get("eventId") != event_id:
            return "requeue"
        if not seen.done():
            seen.set_result(body)
        return "ack"

    try:
        await broker.consume(handler)
        await broker.publish(
            {
                "worker": "none",
                "productionId": "prod_live",
                "eventId": event_id,
                "type": "comic.worker",
            }
        )
        body = await asyncio.wait_for(seen, timeout=5)
    finally:
        await broker.aclose()
        await connection.close()
    assert body["worker"] == "none"
    assert body["type"] == "comic.worker"
