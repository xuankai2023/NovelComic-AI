"""Durable RabbitMQ queue shared by the comic outbox publisher and workers."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

logger = logging.getLogger(__name__)

WORKER_QUEUE = "comic.workers"
WorkerHandler = Callable[[dict[str, Any]], Awaitable[str]]


class RabbitWorkerBroker:
    """One channel on the process RabbitMQ connection. Messages are persistent."""

    def __init__(
        self,
        channel: Any,
        queue: Any,
        *,
        requeue_delay_seconds: float = 1,
    ) -> None:
        self._channel = channel
        self._queue = queue
        self._requeue_delay_seconds = requeue_delay_seconds
        self._consumer_tag: str | None = None

    @classmethod
    async def connect(
        cls,
        connection: AbstractRobustConnection,
        *,
        requeue_delay_seconds: float = 1,
    ) -> RabbitWorkerBroker:
        # RobustChannel.channel() is synchronous; awaiting it opens the channel.
        # set_qos waits on that open, so skipping the await never returns.
        channel = await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=4)
        queue = await channel.declare_queue(WORKER_QUEUE, durable=True)
        return cls(channel, queue, requeue_delay_seconds=requeue_delay_seconds)

    async def publish(self, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        await self._channel.default_exchange.publish(
            aio_pika.Message(
                payload,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type="application/json",
            ),
            routing_key=WORKER_QUEUE,
        )

    async def consume(self, handler: WorkerHandler) -> None:
        async def _on_message(message: AbstractIncomingMessage) -> None:
            try:
                body = json.loads(message.body.decode())
            except (UnicodeError, json.JSONDecodeError):
                logger.error("comic worker message is not json")
                await message.ack()
                return
            if not isinstance(body, dict):
                logger.error("comic worker message is not an object")
                await message.ack()
                return
            try:
                decision = await handler(body)
            except Exception:
                logger.exception("comic worker consumer failed")
                await _requeue(message, self._requeue_delay_seconds)
                return
            if decision == "requeue":
                await _requeue(message, self._requeue_delay_seconds)
                return
            await message.ack()

        self._consumer_tag = await self._queue.consume(_on_message)

    async def aclose(self) -> None:
        if self._consumer_tag is not None:
            try:
                await self._queue.cancel(self._consumer_tag)
            finally:
                self._consumer_tag = None
        await self._channel.close()


async def _requeue(message: AbstractIncomingMessage, delay_seconds: float) -> None:
    if delay_seconds > 0:
        await asyncio.sleep(delay_seconds)
    await message.nack(requeue=True)
