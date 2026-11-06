"""Product API. Routes authenticate, validate, accept, read, and cancel."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..contracts.errors import ComicServiceError
from ..contracts.production_request import ProductionRequest
from ..repositories.production_repository import ProductionNotFoundError
from ..services.production_service import ProductionService

Authenticator = Callable[[Request], Awaitable[str]]

_STATUS = {
    "INVALID_REQUEST": 400,
    "IDEMPOTENCY_CONFLICT": 409,
    "INVALID_STATE_TRANSITION": 409,
    "PRODUCTION_CANCELLED": 409,
    "DRAFT_REVISION_CONFLICT": 409,
    "BUDGET_EXCEEDED": 409,
    "DRAFT_NOT_FOUND": 404,
}


def create_product_router(
    service: ProductionService,
    authenticate: Authenticator,
) -> APIRouter:
    router = APIRouter()

    @router.post("/v1/comic-productions", status_code=202)
    async def create_production(body: ProductionRequest, request: Request) -> JSONResponse:
        return await _call(
            request,
            202,
            lambda tenant_id: _accepted(service, tenant_id, body),
        )

    @router.get("/v1/comic-productions/{production_id}")
    async def get_production(production_id: str, request: Request) -> JSONResponse:
        return await _call(
            request,
            200,
            lambda tenant_id: service.get(tenant_id, production_id),
        )

    @router.post("/v1/comic-productions/{production_id}/cancel")
    async def cancel_production(production_id: str, request: Request) -> JSONResponse:
        return await _call(
            request,
            200,
            lambda tenant_id: service.cancel(tenant_id, production_id, actor="user"),
        )

    @router.get("/v1/comic-productions/{production_id}/deliveries")
    async def get_deliveries(production_id: str, request: Request) -> JSONResponse:
        return await _call(
            request,
            200,
            lambda tenant_id: service.deliveries(tenant_id, production_id),
        )

    async def _call(
        request: Request,
        status_code: int,
        action: Callable[[str], Awaitable[dict[str, Any]]],
    ) -> JSONResponse:
        try:
            tenant_id = await authenticate(request)
            return _json(status_code, await action(tenant_id))
        except ComicServiceError as exc:
            return _error(exc)

    return router


async def _accepted(
    service: ProductionService,
    tenant_id: str,
    body: ProductionRequest,
) -> dict[str, Any]:
    accepted = await service.accept(tenant_id, body)
    return {
        "productionId": accepted.production_id,
        "projectId": accepted.project_id,
        "state": accepted.state.value,
        "replayed": accepted.replayed,
    }


def _json(status_code: int, payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=payload)


def _error(exc: ComicServiceError) -> JSONResponse:
    if isinstance(exc, ProductionNotFoundError):
        status_code = 404
    else:
        status_code = _STATUS.get(exc.code, 422)
    body = exc.body.model_dump(mode="json", by_alias=True)
    return JSONResponse(status_code=status_code, content=body)
