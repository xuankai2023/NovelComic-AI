"""Public Agent catalog endpoints."""

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.services.agent_catalog import AgentCatalogService

router = APIRouter()


def _ok(data: Any) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": jsonable_encoder(data)},
    )


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


def _parse_exclude_ids(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@router.get("/hooks", summary="查询公开 Agent Hooks")
async def list_hooks(
    request: Request,
    hook_type: str | None = Query(default=None, description="hook 分组"),
    page_number: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1),
    exclude_ids: str | None = Query(default=None, description="逗号分隔的 hook_id 排除列表"),
) -> JSONResponse:
    page = await AgentCatalogService.list_hooks(
        _database(request),
        hook_type=hook_type,
        page_number=page_number,
        page_size=page_size,
        exclude_ids=_parse_exclude_ids(exclude_ids),
    )
    return _ok(page.model_dump(mode="json"))


@router.get("/roles", summary="查询公开 Agent Roles")
async def list_roles(
    request: Request,
    page_number: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1),
    exclude_ids: str | None = Query(default=None, description="逗号分隔的 role_id 排除列表"),
) -> JSONResponse:
    page = await AgentCatalogService.list_roles(
        _database(request),
        page_number=page_number,
        page_size=page_size,
        exclude_ids=_parse_exclude_ids(exclude_ids),
    )
    return _ok(page.model_dump(mode="json"))
