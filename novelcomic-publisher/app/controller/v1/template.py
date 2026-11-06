"""Public template marketplace routes (/api/v1/templates/*)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.services.template import TemplateService

router = APIRouter()
_NOT_FOUND = 1010


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.get("/page", summary="分页获取公开模板列表")
async def get_templates_page(
    request: Request,
    page_number: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    keyword: str | None = Query(default=None),
    is_recommend: bool | None = Query(default=None),
    category: str | None = Query(default=None),
    sort_by: str | None = Query(default=None),
) -> JSONResponse:
    data = await TemplateService.get_template_page(
        _database(request),
        page_number=page_number,
        page_size=page_size,
        keyword=keyword,
        is_recommend=is_recommend,
        category=category,
        sort_by=sort_by,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.get("/categories/list", summary="获取公开模板分类列表")
async def get_template_categories(request: Request) -> JSONResponse:
    items = await TemplateService.list_categories(_database(request))
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": items})


@router.get("/{template_id}", summary="获取单个公开模板详情")
async def get_template_detail(request: Request, template_id: str) -> JSONResponse:
    item = await TemplateService.get_template_by_id(_database(request), template_id)
    if item is None:
        return JSONResponse(
            status_code=404,
            content={"code": _NOT_FOUND, "msg": f"Template not found: {template_id}", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": item})
