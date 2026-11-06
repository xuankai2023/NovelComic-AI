"""Dispatch one maintenance command, then stop.

A failed scan is acknowledged. The scheduler pushes the next one. This is
``max_retry_times=0``: the same stream message is not run again.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import get_settings
from app.services.workflow.flow_recovery_service import FlowRecoveryService
from app.tasks.flow import decode_stream_payload
from app.tasks.flow_resume import FlowResumeTask

logger = logging.getLogger(__name__)

MAINTENANCE_GROUP = "novelcomic_consumer_group"
MAX_RETRY_TIMES = 0


class FlowMaintenanceTask:
    @staticmethod
    async def handle_maintenance(
        database: Any,
        *,
        redis_client: Any,
        publisher: Any,
        command: str,
        reason: str | None = None,
    ) -> None:
        if command == "redeliver_due_workflow_commands":
            count = await FlowRecoveryService.redeliver_due_workflow_commands(
                database,
                redis_client=redis_client,
            )
            logger.info("workflow commands redelivered count=%s", count)
            return

        if command == "mark_timed_out_invocations":
            count = await FlowRecoveryService.mark_timed_out_invocations(
                database,
                redis_client=redis_client,
                publisher=publisher,
            )
            logger.info("timed out invocations marked count=%s", count)
            return

        if command == "recover_running_flows":
            run_ids = await FlowRecoveryService.recover_running_flows(database)
            for run_id in run_ids:
                await FlowResumeTask.handle_resume(
                    database,
                    redis_client=redis_client,
                    publisher=publisher,
                    run_id=run_id,
                    reason=reason or "recover",
                )
            logger.info("running flows recovered count=%s", len(run_ids))
            return

        if command == "reconcile_terminal_flow_events":
            count = await FlowRecoveryService.reconcile_terminal_flow_events(
                database,
                publisher,
            )
            logger.info("terminal flow events reconciled count=%s", count)
            return

        if command == "replay_pending_callbacks":
            count = await FlowRecoveryService.replay_pending_callbacks(
                database,
                redis_client=redis_client,
                publisher=publisher,
            )
            logger.info("pending callbacks replayed count=%s", count)
            return

        if command == "recover_stuck_finalize":
            count = await FlowRecoveryService.recover_stuck_finalize(
                database,
                redis_client=redis_client,
                publisher=publisher,
            )
            logger.info("stuck finalize recovered count=%s", count)
            return

        if command == "reconcile_pending_deductions":
            count = await FlowRecoveryService.reconcile_pending_deductions(
                database,
                redis_client=redis_client,
                publisher=publisher,
            )
            logger.info("pending deductions reconciled count=%s", count)
            return

        if command in {"replay_failed_outbox_events", "replay_due_outbox_events"}:
            count = await FlowRecoveryService.replay_due_outbox_events(database, publisher)
            logger.info("due outbox events replayed count=%s", count)
            return

        logger.warning("unknown flow maintenance command=%s", command)


class MaintenanceStreamWorker:
    """Read ``flow_maintenance`` once per message, then ACK."""

    GROUP = MAINTENANCE_GROUP
    MAX_RETRY_TIMES = MAX_RETRY_TIMES

    def __init__(
        self,
        *,
        database: Any,
        redis_client: Any,
        publisher: Any,
        consumer_name: str = "maintenance",
        settings: Any = None,
    ) -> None:
        self.database = database
        self.redis = redis_client
        self.publisher = publisher
        self.consumer_name = consumer_name
        self.settings = settings or get_settings()
        self.stream = self.settings.flow_maintenance_queue_name
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def run(self) -> None:
        await self._ensure_group()
        while not self._stop_event.is_set():
            messages = await self.redis.xreadgroup(
                self.GROUP,
                self.consumer_name,
                {self.stream: ">"},
                count=10,
                block=1000,
            )
            for _stream_name, entries in messages or []:
                for message_id, fields in entries:
                    await self._handle_message(message_id, fields)

    def start(self) -> asyncio.Task[None]:
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self.run(), name="flow-maintenance-consumer")
        return self._task

    def stop(self) -> None:
        self._stop_event.set()

    async def wait_stopped(self) -> None:
        if self._task is not None:
            await self._task

    async def _ensure_group(self) -> None:
        try:
            await self.redis.xgroup_create(self.stream, self.GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def _handle_message(self, message_id: Any, fields: dict[Any, Any]) -> None:
        decoded = decode_stream_payload(fields)
        command = str(decoded.get("command") or "")
        reason = decoded.get("reason")
        try:
            await FlowMaintenanceTask.handle_maintenance(
                self.database,
                redis_client=self.redis,
                publisher=self.publisher,
                command=command,
                reason=str(reason) if reason else None,
            )
        except Exception:
            logger.exception(
                "flow maintenance command failed command=%s message_id=%s",
                command,
                message_id,
            )
        if self.MAX_RETRY_TIMES == 0:
            await self.redis.xack(self.stream, self.GROUP, message_id)
