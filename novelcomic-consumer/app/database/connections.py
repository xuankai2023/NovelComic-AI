import asyncio
from dataclasses import dataclass
from typing import Any

import aio_pika
import redis.asyncio as redis
from motor.motor_asyncio import AsyncIOMotorClient

from app.config import Settings


@dataclass
class Connections:
    mongo: Any
    redis: Any
    rabbitmq: Any | None
    rabbitmq_url: str
    timeout: float

    @classmethod
    async def connect(cls, settings: Settings) -> "Connections":
        return cls(
            AsyncIOMotorClient(settings.mongo_url),
            redis.from_url(settings.redis_url),
            None,
            settings.rabbitmq_url,
            settings.dependency_timeout_seconds,
        )

    async def ensure_rabbitmq(self) -> Any:
        connection = self.rabbitmq
        if connection is not None and not connection.is_closed:
            return connection
        self.rabbitmq = await aio_pika.connect_robust(self.rabbitmq_url, timeout=self.timeout)
        return self.rabbitmq

    async def close(self) -> None:
        self.mongo.close()
        await self.redis.aclose()
        if self.rabbitmq is not None:
            await self.rabbitmq.close()

    async def checks(self) -> dict[str, bool]:
        async def mongo_check() -> bool:
            await self.mongo.admin.command("ping")
            return True

        async def redis_check() -> bool:
            return bool(await self.redis.ping())

        async def rabbitmq_check() -> bool:
            connection = await self.ensure_rabbitmq()
            return not connection.is_closed

        names = ("mongo", "redis", "rabbitmq")
        results = await asyncio.gather(
            *(
                asyncio.wait_for(check(), timeout=self.timeout)
                for check in (mongo_check, redis_check, rabbitmq_check)
            ),
            return_exceptions=True,
        )
        return {name: result is True for name, result in zip(names, results, strict=True)}
