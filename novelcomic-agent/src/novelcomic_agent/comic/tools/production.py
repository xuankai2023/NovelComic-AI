"""Production tools delegate to the application service."""

from __future__ import annotations

from typing import Any

from ..contracts.production_request import ProductionRequest
from ..services.production_service import ProductionService


class ProductionTools:
    def __init__(self, service: ProductionService) -> None:
        self._service = service

    async def start(
        self,
        tenant_id: str,
        request: ProductionRequest,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if idempotency_key is not None:
            request = request.model_copy(update={"prod_client_request_id": idempotency_key})
        accepted = await self._service.accept(tenant_id, request)
        return {
            "productionId": accepted.production_id,
            "projectId": accepted.project_id,
            "state": accepted.state.value,
            "replayed": accepted.replayed,
        }

    async def status(self, tenant_id: str, production_id: str) -> dict[str, Any]:
        return await self._service.get(tenant_id, production_id)

    async def cancel(
        self,
        tenant_id: str,
        production_id: str,
        *,
        actor: str = "user",
    ) -> dict[str, Any]:
        return await self._service.cancel(tenant_id, production_id, actor=actor)
