"""Start the maintenance consumer and, when enabled, its scheduler lock."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from app.config import get_settings
from app.tasks.flow_maintenance import MaintenanceStreamWorker

logger = logging.getLogger(__name__)

MAINTENANCE_SCHEDULER_LOCK_PREFIX = "opencreator:flow_maintenance_scheduler:"
SCHEDULER_POLL_SECONDS = 10


def maintenance_command_intervals(settings: Any) -> dict[str, int]:
    default_interval = settings.flow_maintenance_interval_seconds
    return {
        "redeliver_due_workflow_commands": settings.flow_command_inbox_sweep_interval_seconds,
        "mark_timed_out_invocations": default_interval,
        "replay_pending_callbacks": default_interval,
        "recover_stuck_finalize": default_interval,
        "reconcile_pending_deductions": default_interval,
        "replay_due_outbox_events": default_interval,
        "recover_running_flows": settings.flow_recover_running_interval_seconds,
        "reconcile_terminal_flow_events": default_interval,
    }


def scheduler_lock_ttl(interval: int) -> int:
    return max(interval - 1, 1)


def maintenance_message(command: str, reason: str = "scheduler") -> dict[str, str]:
    body = {"command": command, "reason": reason}
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return {"command": command, "payload": encoded, "reason": reason}


class MaintenanceScheduler:
    """Claim a per-command lock, then push that command onto the maintenance stream."""

    def __init__(
        self,
        redis_client: Any,
        *,
        settings: Any = None,
        instance_id: str | None = None,
        clock: Any = time.monotonic,
    ) -> None:
        if redis_client is None:
            raise ValueError("redis_client is required")
        self.redis = redis_client
        self.settings = settings or get_settings()
        self.instance_id = instance_id or os.getenv("CONSUMER_INSTANCE_ID", str(os.getpid()))
        self._clock = clock
        self._commands = maintenance_command_intervals(self.settings)
        self._last_run = {command: 0.0 for command in self._commands}
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def tick(self, now: float | None = None) -> list[str]:
        if not self.settings.flow_maintenance_scheduler_enabled:
            return []
        current = self._clock() if now is None else now
        pushed: list[str] = []
        for command, interval in self._commands.items():
            if current - self._last_run[command] < interval:
                continue
            lock_key = f"{MAINTENANCE_SCHEDULER_LOCK_PREFIX}{command}"
            locked = await self.redis.set(
                lock_key,
                self.instance_id,
                ex=scheduler_lock_ttl(interval),
                nx=True,
            )
            self._last_run[command] = current
            if locked:
                await self.redis.xadd(
                    self.settings.flow_maintenance_queue_name,
                    maintenance_message(command),
                )
                pushed.append(command)
        return pushed

    async def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.tick()
            except Exception:
                logger.warning("flow maintenance scheduler tick failed", exc_info=True)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=SCHEDULER_POLL_SECONDS)
            except TimeoutError:
                continue

    def start(self) -> asyncio.Task[None]:
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self.run(), name="flow-maintenance-scheduler")
        return self._task

    def stop(self) -> None:
        self._stop_event.set()

    async def wait_stopped(self) -> None:
        if self._task is not None:
            await self._task


class MaintenanceRuntime:
    def __init__(
        self,
        worker: MaintenanceStreamWorker,
        scheduler: MaintenanceScheduler | None,
    ) -> None:
        self.worker = worker
        self.scheduler = scheduler

    def stop(self) -> None:
        self.worker.stop()
        if self.scheduler is not None:
            self.scheduler.stop()

    async def wait_stopped(self) -> None:
        await self.worker.wait_stopped()
        if self.scheduler is not None:
            await self.scheduler.wait_stopped()


def register_maintenance_tasks(
    database: Any,
    redis_client: Any,
    publisher: Any,
    *,
    settings: Any = None,
    instance_id: str | None = None,
    consumer_name: str = "maintenance",
) -> MaintenanceRuntime:
    """Start the ``flow_maintenance`` consumer, then the scheduler if it is enabled."""

    resolved = settings or get_settings()
    worker = MaintenanceStreamWorker(
        database=database,
        redis_client=redis_client,
        publisher=publisher,
        consumer_name=consumer_name,
        settings=resolved,
    )
    worker.start()
    scheduler = start_maintenance_scheduler(
        redis_client,
        settings=resolved,
        instance_id=instance_id,
    )
    logger.info(
        "flow maintenance consumer started queue=%s scheduler=%s",
        resolved.flow_maintenance_queue_name,
        scheduler is not None,
    )
    return MaintenanceRuntime(worker, scheduler)


def start_maintenance_scheduler(
    redis_client: Any,
    *,
    settings: Any = None,
    instance_id: str | None = None,
) -> MaintenanceScheduler | None:
    """Start the loop only when ``FLOW_MAINTENANCE_SCHEDULER_ENABLED`` is true."""

    resolved = settings or get_settings()
    if not resolved.flow_maintenance_scheduler_enabled:
        logger.info("flow maintenance scheduler disabled")
        return None
    scheduler = MaintenanceScheduler(
        redis_client,
        settings=resolved,
        instance_id=instance_id,
    )
    scheduler.start()
    return scheduler
