"""Intake gate for the ``run_flow`` stream consumer.

``ACTIVE`` reads new messages. ``DRAINING`` skips ``XREADGROUP`` until the
inflight set is empty, then becomes ``STOPPED`` and sleeps. ``STOPPED`` does
not exit, so a process supervisor cannot restart it back onto the stream.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

INTAKE_ACTIVE = "ACTIVE"
INTAKE_DRAINING = "DRAINING"
INTAKE_STOPPED = "STOPPED"


def intake_key(instance_id: str) -> str:
    return f"opencreator:consumer:intake:{instance_id}"


def inflight_key(instance_id: str) -> str:
    return f"opencreator:consumer:inflight:{instance_id}"


def heartbeat_key(instance_id: str) -> str:
    return f"opencreator:consumer:heartbeat:{instance_id}"


def decode_redis_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


class DrainableRedisStreamConsumer:
    """``run_flow`` reader. Other streams keep their own consumers."""

    heartbeat_ttl_seconds = 30
    draining_pause_seconds = 2
    stopped_pause_seconds = 5
    read_count = 10
    read_block_ms = 1000

    def __init__(
        self,
        redis_client: Any,
        *,
        instance_id: str,
        queue_name: str,
        group: str,
        consumer_name: str,
        stop_event: asyncio.Event | None = None,
        clock: Any = time.time,
    ) -> None:
        self.redis = redis_client
        self.instance_id = instance_id
        self.queue_name = queue_name
        self.group = group
        self.consumer_name = consumer_name
        self.stop_event = stop_event
        self._clock = clock
        self.state_key = intake_key(instance_id)
        self.inflight_key = inflight_key(instance_id)
        self.heartbeat_key = heartbeat_key(instance_id)

    async def startup(self) -> str:
        """Missing and ``STOPPED`` become ``ACTIVE``. ``DRAINING`` stays."""

        current = decode_redis_value(await self.redis.get(self.state_key))
        if current == INTAKE_DRAINING:
            return INTAKE_DRAINING
        await self.redis.set(self.state_key, INTAKE_ACTIVE)
        return INTAKE_ACTIVE

    async def read_once(self) -> list[Any]:
        """Return one ``XREADGROUP`` batch, or nothing while intake is closed."""

        if self.stop_event is not None and self.stop_event.is_set():
            return []
        await self.redis.setex(
            self.heartbeat_key,
            self.heartbeat_ttl_seconds,
            str(self._clock()),
        )
        state = decode_redis_value(await self.redis.get(self.state_key)) or INTAKE_ACTIVE
        if state == INTAKE_STOPPED:
            await self._pause(self.stopped_pause_seconds)
            return []
        if state == INTAKE_DRAINING:
            inflight_count = int(await self.redis.scard(self.inflight_key) or 0)
            if inflight_count == 0:
                await self.redis.set(self.state_key, INTAKE_STOPPED)
                await self._pause(self.stopped_pause_seconds)
            else:
                await self._pause(self.draining_pause_seconds)
            return []
        messages = await self.redis.xreadgroup(
            self.group,
            self.consumer_name,
            {self.queue_name: ">"},
            count=self.read_count,
            block=self.read_block_ms,
        )
        return list(messages or [])

    async def add_inflight(self, message_id: object) -> None:
        await self.redis.sadd(self.inflight_key, str(message_id))

    async def remove_inflight(self, message_id: object) -> None:
        await self.redis.srem(self.inflight_key, str(message_id))

    async def _pause(self, seconds: float) -> None:
        if seconds <= 0:
            return
        if self.stop_event is None:
            await asyncio.sleep(seconds)
            return
        try:
            await asyncio.wait_for(self.stop_event.wait(), timeout=seconds)
        except TimeoutError:
            return
