"""Bound batch planning and failed-batch retry for operators."""

from __future__ import annotations

from typing import Any

from ..workers.render_worker import RenderWorker


class BatchTools:
    def __init__(self, render_worker: RenderWorker) -> None:
        self._render_worker = render_worker

    async def plan(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        row = await self._render_worker.plan_bound(
            tenant_id=tenant_id,
            production_id=production_id,
            revision=revision,
            content_hash=content_hash,
        )
        return {
            "productionId": production_id,
            "revision": revision,
            "contentHash": content_hash,
            "batches": row,
        }

    async def render(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
        force: bool = False,
    ) -> dict[str, Any]:
        snapshot = await self._render_worker.retry_failed(
            tenant_id=tenant_id,
            production_id=production_id,
            revision=revision,
            content_hash=content_hash,
            force=force,
        )
        return {
            "productionId": snapshot.production_id,
            "state": snapshot.state.value,
            "revision": revision,
            "contentHash": content_hash,
            "force": force,
        }
