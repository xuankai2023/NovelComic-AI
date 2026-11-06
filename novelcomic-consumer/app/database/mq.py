"""RabbitMQ publishers used by workflow v2 events."""

from __future__ import annotations

import json
from typing import Any

import aio_pika
from aio_pika.abc import AbstractRobustConnection

from app.config import get_settings

V2_REPLY_QUEUE_NAME = get_settings().v2_reply_queue


class ConnectionReplyPublisher:
    """Consumer 运行时用的回复发布器：先拿到 RabbitMQ 连接，再走 MessagePublisher。"""

    def __init__(self, connections: Any) -> None:
        self.connections = connections

    async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
        connection = await self.connections.ensure_rabbitmq()
        await MessagePublisher(connection).publish(queue_name=queue_name, payload=payload)


class MessagePublisher:
    def __init__(self, connection: AbstractRobustConnection) -> None:
        self.connection = connection

    async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
        channel = await self.connection.channel()
        try:
            await channel.declare_queue(queue_name, durable=True)
            body = json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
            message = aio_pika.Message(
                body=body,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            )
            await channel.default_exchange.publish(message, routing_key=queue_name)
        finally:
            await channel.close()
