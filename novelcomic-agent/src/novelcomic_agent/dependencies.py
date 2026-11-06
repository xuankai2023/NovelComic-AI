"""External dependency lifecycle and health checks."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import aio_pika
import asyncpg
from aio_pika.abc import AbstractRobustConnection
from pymongo import AsyncMongoClient
from redis.asyncio import Redis

from novelcomic_agent.comic.persistence.postgres import create_pool
from novelcomic_agent.config import Settings
from novelcomic_agent.database.mongo import ensure_indexes

logger = logging.getLogger(__name__)


class DependencyManager:
    """Own MongoDB, Redis, RabbitMQ, and PostgreSQL clients for the application lifespan."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.mongo = AsyncMongoClient(settings.mongodb_uri)
        self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
        self.rabbitmq: AbstractRobustConnection | None = None
        self.postgres: asyncpg.Pool | None = None
        self._rabbitmq_lock = asyncio.Lock()
        self._postgres_lock = asyncio.Lock()

    async def start(self) -> None:
        """Build Mongo indexes, then warm RabbitMQ.

        索引失败要挡住启动。RabbitMQ 连不上只记在就绪检查里。
        这一步对应 OpenCreator `creato/api/server.py` 启动时的 `ensure_indexes()`。
        """

        await ensure_indexes(self.mongo[self.settings.mongodb_database])
        try:
            async with asyncio.timeout(self.settings.dependency_timeout_seconds):
                await self._ensure_rabbitmq()
        except Exception:
            # Readiness reports the failure and later probes retry the connection.
            self.rabbitmq = None
        try:
            async with asyncio.timeout(self.settings.dependency_timeout_seconds):
                await self._ensure_postgres()
        except Exception as exc:
            logger.warning("postgresql unavailable: %s", type(exc).__name__)
            await self._drop_postgres()

    async def close(self) -> None:
        """Close all clients owned by this manager."""

        await self._drop_postgres()
        if self.rabbitmq is not None and not self.rabbitmq.is_closed:
            await self.rabbitmq.close()
        await self.redis.aclose()
        await self.mongo.close()

    async def rabbitmq_connection(self) -> AbstractRobustConnection:
        """Return the process RabbitMQ connection, opening it when the first probe failed."""

        return await self._ensure_rabbitmq()

    async def check_all(self) -> dict[str, dict[str, Any]]:
        """Probe every infrastructure dependency independently."""

        results = await asyncio.gather(
            self._run_check("mongodb", self._check_mongodb),
            self._run_check("redis", self._check_redis),
            self._run_check("rabbitmq", self._check_rabbitmq),
            self._run_check("postgres", self._check_postgres),
        )
        return dict(results)

    async def _run_check(
        self,
        name: str,
        check: Callable[[], Awaitable[None]],
    ) -> tuple[str, dict[str, Any]]:
        try:
            async with asyncio.timeout(self.settings.dependency_timeout_seconds):
                await check()
        except Exception as exc:
            return name, {"status": "error", "detail": type(exc).__name__}
        return name, {"status": "ok"}

    async def _check_mongodb(self) -> None:
        await self.mongo.admin.command("ping")

    async def _check_redis(self) -> None:
        await self.redis.ping()

    async def _check_rabbitmq(self) -> None:
        connection = await self._ensure_rabbitmq()
        channel = await connection.channel()
        await channel.close()

    async def _check_postgres(self) -> None:
        pool = await self._ensure_postgres()
        async with pool.acquire() as connection:
            await connection.execute("SELECT 1")

    async def _ensure_postgres(self) -> asyncpg.Pool:
        async with self._postgres_lock:
            if self.postgres is None:
                self.postgres = await create_pool(self.settings.comic_database_url)
            return self.postgres

    async def _drop_postgres(self) -> None:
        pool = self.postgres
        self.postgres = None
        if pool is not None:
            await pool.close()

    async def _ensure_rabbitmq(self) -> AbstractRobustConnection:
        async with self._rabbitmq_lock:
            if self.rabbitmq is None or self.rabbitmq.is_closed:
                self.rabbitmq = await aio_pika.connect_robust(self.settings.rabbitmq_url)
            return self.rabbitmq
