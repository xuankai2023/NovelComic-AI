"""Dispatch durable comic worker messages onto the stage B workers."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from ..contracts.errors import ComicServiceError
from ..repositories.production_repository import ProductionRepository, worker_for_state
from ..workflow.production_states import TERMINAL_STATES, ProductionState

logger = logging.getLogger(__name__)

WorkerRun = Callable[[str], Awaitable[Any]]
_DEFERRED = frozenset({"preview", "package"})


class WorkerConsumer:
    """Stage B runs analyze, voice, and render. Later workers are acknowledged only.

    When an asset worker is bound, ``PREPARING_ASSETS`` is handled there even
    though the outbox still names the render worker for that state.
    """

    def __init__(
        self,
        *,
        analyze: WorkerRun,
        voice: WorkerRun,
        render: WorkerRun,
        productions: ProductionRepository,
        assets: WorkerRun | None = None,
    ) -> None:
        self._runners = {
            "analyze": analyze,
            "voice": voice,
            "render": render,
        }
        self._assets = assets
        self._productions = productions
        self._locks: dict[str, asyncio.Lock] = {}

    async def handle(self, message: dict[str, Any]) -> str:
        worker = message.get("worker")
        production_id = message.get("productionId")
        if isinstance(production_id, str) and production_id and worker not in {None, "none"}:
            lock = self._locks.setdefault(production_id, asyncio.Lock())
            async with lock:
                return await self._handle(message)
        return await self._handle(message)

    async def _handle(self, message: dict[str, Any]) -> str:
        worker = message.get("worker")
        production_id = message.get("productionId")
        # Missing worker (legacy cancel / non-worker outbox) is an ack, same as "none".
        if worker is None or worker == "none":
            return "ack"
        if worker in _DEFERRED:
            logger.error(
                "stage B has no %s worker for production %s",
                worker,
                production_id,
            )
            return "ack"
        run = self._runners.get(worker) if isinstance(worker, str) else None
        if run is None:
            logger.error("stage B ignored unknown worker %s", worker)
            return "ack"
        if not isinstance(production_id, str) or not production_id:
            logger.error("stage B ignored a %s message without productionId", worker)
            return "ack"
        try:
            before = await self._productions.get_row(production_id)
        except ComicServiceError as exc:
            return "requeue" if exc.body.retryable else "ack"
        if (
            worker == "render"
            and self._assets is not None
            and ProductionState(before.state) is ProductionState.PREPARING_ASSETS
        ):
            run = self._assets
        try:
            await run(production_id)
        except ComicServiceError as exc:
            if exc.body.retryable:
                return "requeue"
            await self._productions.record_error(
                production_id,
                code=exc.code,
                message=exc.body.message,
            )
            return "ack"
        except Exception:
            logger.exception("comic worker %s failed for %s", worker, production_id)
            return "requeue"
        after = await self._productions.get_row(production_id)
        return _after_run(worker, before.state, before, after)


def _after_run(worker: str, previous_state: str, before: Any, after: Any) -> str:
    state = ProductionState(after.state)
    if state in TERMINAL_STATES:
        return "ack"
    # Acceptance writes worker=analyze while the row is still CREATED.
    if worker_for_state(state) != worker and not (
        worker == "analyze" and state is ProductionState.CREATED
    ):
        return "ack"
    if after.state != previous_state:
        return "ack"
    if (
        after.last_error_code != before.last_error_code
        or after.last_error_message != before.last_error_message
    ):
        return "ack"
    return "requeue"
