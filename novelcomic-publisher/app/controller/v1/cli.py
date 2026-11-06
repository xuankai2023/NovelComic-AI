"""CLI device authorization and ak_ token endpoints (/api/v1/cli/*)."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.services.cli_device_auth import CliDeviceAuthService

router = APIRouter()


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


class CreateCliDeviceCodeBody(BaseModel):
    client_name: str = Field(default="OpenCreator CLI", max_length=80)
    device_name: str | None = Field(default=None, max_length=120)
    os_info: str | None = Field(default=None, max_length=120)


class DecideCliDeviceAuthorizationBody(BaseModel):
    user_code: str = Field(min_length=4, max_length=32)
    action: Literal["approve", "deny", "allow", "approved", "denied"] = "approve"


class ExchangeCliDeviceTokenBody(BaseModel):
    device_code: str = Field(min_length=4)


@router.post("/device/code", summary="CLI 申请 device_code 与 user_code（公开）")
async def create_cli_device_code_endpoint(
    request: Request,
    body: CreateCliDeviceCodeBody | None = None,
) -> JSONResponse:
    req = body or CreateCliDeviceCodeBody()
    data = await CliDeviceAuthService.create_device_code(
        _database(request),
        client_name=req.client_name,
        device_name=req.device_name,
        os_info=req.os_info,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.get("/device/authorization", summary="浏览器页按 user_code 查询待授权设备详情")
async def get_cli_device_authorization_endpoint(
    request: Request,
    _user: Annotated[AuthUser, Depends(get_authenticated_user)],
    user_code: str = Query(..., min_length=4),
) -> JSONResponse:
    data = await CliDeviceAuthService.get_device_authorization_by_user_code(
        _database(request),
        user_code=user_code,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.post("/device/authorization", summary="用户在网页端批准或拒绝设备授权")
async def decide_cli_device_authorization_endpoint(
    request: Request,
    body: DecideCliDeviceAuthorizationBody,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    data = await CliDeviceAuthService.decide_device_authorization(
        _database(request),
        user_id=user.user_id,
        user_code=body.user_code,
        action=body.action,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.post("/device/token", summary="CLI 轮询用 device_code 换取 ak_ 令牌（公开）")
async def exchange_cli_device_token_endpoint(
    request: Request,
    body: ExchangeCliDeviceTokenBody,
) -> JSONResponse:
    data = await CliDeviceAuthService.exchange_device_token(
        _database(request),
        device_code=body.device_code,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.get("/info", summary="CLI 查询当前用户信息与积分余额（仅接受 ak_）")
async def get_cli_info_endpoint(request: Request) -> JSONResponse:
    database = _database(request)
    token_doc = await CliDeviceAuthService.authenticate_ak_token(
        database,
        authorization_header=request.headers.get("Authorization"),
    )
    info = await CliDeviceAuthService.get_cli_info(database, token_doc=token_doc)
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": info})


@router.post("/logout", summary="CLI 吊销当前 ak_ 令牌")
async def cli_logout_endpoint(request: Request) -> JSONResponse:
    database = _database(request)
    token_doc = await CliDeviceAuthService.authenticate_ak_token(
        database,
        authorization_header=request.headers.get("Authorization"),
    )
    await CliDeviceAuthService.revoke_ak_token(database, token_doc=token_doc)
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": {"revoked": True}})
