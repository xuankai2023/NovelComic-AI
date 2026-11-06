"""Public model catalog endpoints."""

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.services.model_config import ModelConfigService
from app.services.model_dropdown_order import ModelDropdownOrderService

router = APIRouter()
_CLIENT_ERROR = 1003


def _ok(data: Any) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": jsonable_encoder(data)},
    )


def _fail(msg: str, http_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=http_code,
        content={"code": _CLIENT_ERROR, "msg": msg, "data": None},
    )


@router.get("/list", summary="查询公开模型配置列表")
async def list_public_model_configs(
    request: Request,
    config_name: str = Query(..., description="节点类型；传 all 返回全部"),
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    if config_name == "all":
        data = await ModelConfigService.list_all(database)
    else:
        data = await ModelConfigService.list_by_config_name(database, config_name)
    return _ok(data)


@router.get("/dropdown-order", summary="查询模型下拉排序")
async def get_model_dropdown_order(
    request: Request,
    group: str = Query(default="all", description="下拉分组；传 all 返回全部"),
) -> JSONResponse:
    if not ModelDropdownOrderService.is_valid_group(group):
        return _fail(
            "Invalid group. Use all / atom / text_to_image / image_to_image / "
            "text_to_video / image_to_video / all_round_video",
        )
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    data = await ModelDropdownOrderService.get_dropdown_order(database, group=group)
    return _ok(data.model_dump(mode="json"))
