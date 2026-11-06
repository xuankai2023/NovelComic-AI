"""Internal model configuration endpoints."""

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.schemas.request_schemas.model_config_request import (
    DeleteModelConfigRequest,
    UpsertModelConfigRequest,
)
from app.schemas.request_schemas.model_dropdown_order_request import (
    BatchUpdateModelSortRequest,
    UpsertBrandOrderRequest,
)
from app.services.model_config import ModelConfigService
from app.services.model_dropdown_order import ModelDropdownOrderService

router = APIRouter()
_CLIENT_ERROR = 1003
_NOT_FOUND = 1010


def _ok(data: Any = None, msg: str = "ok") -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": msg, "data": jsonable_encoder(data)},
    )


def _fail(msg: str, http_code: int = 400, code: int = _CLIENT_ERROR) -> JSONResponse:
    return JSONResponse(status_code=http_code, content={"code": code, "msg": msg, "data": None})


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


def _redis(request: Request) -> Any:
    return request.app.state.connections.redis


@router.get("/list", summary="查询模型配置列表")
async def list_model_configs(
    request: Request,
    config_name: str = Query(..., description="节点类型；传 all 返回全部"),
) -> JSONResponse:
    database = _database(request)
    if config_name == "all":
        data = await ModelConfigService.list_all(database)
    else:
        data = await ModelConfigService.list_by_config_name(database, config_name)
    return _ok(data)


@router.post("/upsert", summary="新增或更新模型配置")
async def upsert_model_config(body: UpsertModelConfigRequest, request: Request) -> JSONResponse:
    data = body.model_dump(exclude={"config_name", "model_id"})
    await ModelConfigService.upsert(
        database=_database(request),
        redis_client=_redis(request),
        config_name=body.config_name,
        model_id=body.model_id,
        data=data,
    )
    return _ok(msg="Model config saved")


@router.post("/delete", summary="删除模型配置")
async def delete_model_config(body: DeleteModelConfigRequest, request: Request) -> JSONResponse:
    success = await ModelConfigService.delete(
        database=_database(request),
        redis_client=_redis(request),
        config_name=body.config_name,
        model_id=body.model_id,
    )
    if not success:
        return _fail(f"Model '{body.model_id}' not found", http_code=404, code=_NOT_FOUND)
    return _ok(msg="Model config deleted")


@router.get("/dropdown-order", summary="查询模型下拉排序")
async def get_internal_model_dropdown_order(
    request: Request,
    group: str = Query(default="all", description="下拉分组；传 all 返回全部"),
) -> JSONResponse:
    if not ModelDropdownOrderService.is_valid_group(group):
        return _fail(
            "Invalid group. Use all / atom / text_to_image / image_to_image / "
            "text_to_video / image_to_video / all_round_video",
        )
    data = await ModelDropdownOrderService.get_dropdown_order(_database(request), group=group)
    return _ok(data.model_dump(mode="json"))


@router.put("/dropdown-order/brands", summary="更新厂牌顺序")
async def upsert_model_dropdown_brand_order(
    body: UpsertBrandOrderRequest,
    request: Request,
) -> JSONResponse:
    try:
        data = await ModelDropdownOrderService.upsert_brand_order(
            _database(request),
            image=body.image,
            video=body.video,
        )
    except ValueError as exc:
        return _fail(str(exc))
    return _ok(data.model_dump(mode="json"), msg="Brand order saved")


@router.post("/dropdown-order/models", summary="批量更新模型排序字段")
async def batch_update_model_dropdown_sort(
    body: BatchUpdateModelSortRequest,
    request: Request,
) -> JSONResponse:
    data = await ModelDropdownOrderService.batch_update_models(_database(request), body.items)
    return _ok(data)
