"""V3 App Flow endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.request_schemas.app_flow.create_app_flow_request import CreateAppFlowRequest
from app.schemas.request_schemas.app_flow.update_app_flow_request import UpdateAppFlowRequest
from app.services.app_flow import (
    AppFlowAlreadyExistsError,
    AppFlowNotFoundError,
    AppFlowService,
    AppFlowSourceNotFoundError,
)

router = APIRouter()
_APP_FLOW_EXISTS = 6001
_APP_FLOW_NOT_FOUND = 6002
_FLOW_NOT_FOUND = 1010


def _ok(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": 200, "msg": "ok", "data": jsonable_encoder(data)},
    )


def _fail(code: int, msg: str, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": code, "msg": msg, "data": None})


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


@router.post("", summary="创建 App Flow")
async def create_app_flow(
    body: CreateAppFlowRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        app_flow = await AppFlowService.create_app_flow(
            database=_database(request),
            req=body,
            user_id=user.user_id,
        )
    except AppFlowAlreadyExistsError:
        return _fail(_APP_FLOW_EXISTS, "App Flow already exists", 409)
    except AppFlowSourceNotFoundError:
        return _fail(_FLOW_NOT_FOUND, "Flow project not found", 404)
    return _ok(app_flow.model_dump(mode="json"), status_code=201)


@router.get("/{flow_id}", summary="读取 App Flow")
async def get_app_flow(
    flow_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    app_flow = await AppFlowService.get_app_flow(database=_database(request), flow_id=flow_id)
    if app_flow is None:
        return _ok(None)
    return _ok(app_flow.model_dump(mode="json"))


@router.patch("/{flow_id}", summary="更新 App Flow")
async def update_app_flow(
    flow_id: str,
    body: UpdateAppFlowRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        app_flow = await AppFlowService.update_app_flow(
            database=_database(request),
            flow_id=flow_id,
            req=body,
            user_id=user.user_id,
        )
    except AppFlowNotFoundError:
        return _fail(_APP_FLOW_NOT_FOUND, "App Flow not found", 404)
    except AppFlowSourceNotFoundError:
        return _fail(_FLOW_NOT_FOUND, "Flow project not found", 404)
    return _ok(app_flow.model_dump(mode="json"))
