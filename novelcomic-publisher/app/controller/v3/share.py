"""V3 share endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.common.exception.exception_share import ShareError
from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.request_schemas.share.create_share_request import CreateShareRequest
from app.schemas.share import ShareInfoResponse, ShareVisitResponse
from app.services.share import ShareService

router = APIRouter()


def _ok(data: dict[str, Any], status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": 200, "msg": "ok", "data": data})


def _fail(exc: ShareError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.response_code, "msg": str(exc), "data": None},
    )


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


def _info_response(share: dict[str, Any]) -> dict[str, Any]:
    data = {
        "share_id": share["share_id"],
        "flow_id": share["flow_id"],
        "owner_user_id": share["owner_user_id"],
        "share_type": share["share_type"],
        "allow_reshare": share["allow_reshare"],
        "need_auth": bool(share.get("email_whitelist") or []),
        "snapshot": share.get("snapshot"),
    }
    return ShareInfoResponse(**data).model_dump(mode="json")


def _visit_response(share: dict[str, Any]) -> dict[str, Any]:
    data = {
        "share_id": share["share_id"],
        "flow_id": share["flow_id"],
        "owner_user_id": share["owner_user_id"],
        "share_type": share["share_type"],
        "allow_reshare": share["allow_reshare"],
        "snapshot": share["snapshot"],
    }
    return ShareVisitResponse(**data).model_dump(mode="json")


@router.post("", summary="创建 V3 flow 分享")
async def create_share(
    body: CreateShareRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        share = await ShareService.create_share_flow_v3(
            database=_database(request),
            req=body,
            user_id=user.user_id,
            user_email=user.email,
        )
    except ShareError as exc:
        return _fail(exc)
    return _ok(_info_response(share), status_code=201)


@router.get("/{share_id}/info", summary="公开读取分享基础信息")
async def get_share_info(share_id: str, request: Request) -> JSONResponse:
    try:
        share = await ShareService.get_share_info(database=_database(request), share_id=share_id)
    except ShareError as exc:
        return _fail(exc)
    return _ok(_info_response(share))


@router.post("/{share_id}/visit", summary="登录访问 V3 分享快照")
async def visit_share(
    share_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        share = await ShareService.visit_share(
            database=_database(request),
            share_id=share_id,
            user_email=user.email,
        )
    except ShareError as exc:
        return _fail(exc)
    return _ok(_visit_response(share))
