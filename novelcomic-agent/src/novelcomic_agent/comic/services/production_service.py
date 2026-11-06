"""Application service shared by the product API and the production tools."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from ..canonical import hash_content, project_content_hash
from ..contracts.errors import ComicServiceError
from ..contracts.production_request import ProductionRequest
from ..rendering.remotion_client import RenderingGateway
from ..repositories.production_repository import (
    AcceptedProduction,
    ProductionNotFoundError,
    ProductionRepository,
)
from ..repositories.render_repository import RenderRepository
from ..storage.object_store import ObjectStore
from ..units import fen_to_rmb
from ..workflow.production_states import ProductionState


class ProductionService:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        renders: RenderRepository,
        objects: ObjectStore,
        remotion: RenderingGateway,
        phase: str = "B",
    ) -> None:
        self._productions = productions
        self._renders = renders
        self._objects = objects
        self._remotion = remotion
        self._phase = phase

    async def accept(self, tenant_id: str, request: ProductionRequest) -> AcceptedProduction:
        payload_hash = hash_content(request.model_dump(mode="json", by_alias=True))
        existing = await self._productions.find_by_request(
            tenant_id,
            request.prod_client_request_id,
        )
        if existing is not None:
            if existing.request_hash != payload_hash:
                raise ComicServiceError(
                    "IDEMPOTENCY_CONFLICT",
                    "idempotency key was already used for a different request",
                    retryable=False,
                )
            return AcceptedProduction(
                production_id=existing.production_id,
                project_id=existing.project_id,
                state=ProductionState(existing.state),
                version=existing.version,
                replayed=True,
                request_hash=existing.request_hash,
            )
        production_id = f"prod_{uuid4().hex}"
        project_id = f"prj_{uuid4().hex}"
        project = await self._remotion.create_project(
            width=request.output.width,
            height=request.output.height,
            fps=request.output.fps,
            client_request_id=production_id,
        )
        return await self._productions.accept(
            tenant_id=tenant_id,
            request=request,
            project=project,
            content_hash=project_content_hash(project),
            production_id=production_id,
            project_id=project_id,
            phase=self._phase,
        )

    async def get(self, tenant_id: str, production_id: str) -> dict[str, Any]:
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        return _status(row)

    async def cancel(self, tenant_id: str, production_id: str, *, actor: str) -> dict[str, Any]:
        row = await self._productions.cancel(
            tenant_id=tenant_id,
            production_id=production_id,
            actor=actor,
        )
        return _status(row)

    async def deliveries(self, tenant_id: str, production_id: str) -> dict[str, Any]:
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        if row.state != ProductionState.DELIVERED.value:
            return {"productionId": row.production_id, "state": row.state, "deliveries": []}
        fact = row.stage_facts.get("RENDERING_BATCHES") or {}
        content_hash = fact.get("contentHash")
        if not isinstance(content_hash, str):
            return {"productionId": row.production_id, "state": row.state, "deliveries": []}
        deliveries = []
        for batch in await self._renders.list_for_hash(row.project_id, content_hash):
            if batch.status != "completed" or not batch.object_key or not batch.checksum:
                continue
            deliveries.append(
                {
                    "batchId": batch.batch_id,
                    "objectKey": batch.object_key,
                    "checksum": batch.checksum,
                    "url": await self._objects.signed_url(batch.object_key),
                }
            )
        return {
            "productionId": row.production_id,
            "state": row.state,
            "deliveries": deliveries,
        }

    async def ensure_paid_work_allowed(self, production_id: str) -> None:
        row = await self._productions.get_row(production_id)
        if row.cancel_requested_at is not None or row.state == ProductionState.CANCELLED.value:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "cancelled productions cannot start paid work",
                retryable=False,
            )


def _status(row: Any) -> dict[str, Any]:
    return {
        "productionId": row.production_id,
        "projectId": row.project_id,
        "state": row.state,
        "version": row.version,
        "degraded": row.degraded,
        "canProducePlayable": row.can_produce_playable,
        "reservedFen": row.reserved_cost_fen,
        "costFen": row.actual_cost_fen,
        "costRmb": str(fen_to_rmb(row.actual_cost_fen)),
        "lastErrorCode": row.last_error_code,
        "lastErrorMessage": row.last_error_message,
    }
