"""V2 share visit endpoint used by in-canvas cloning."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.common.exception.exception_share import ShareError
from app.config import get_settings
from app.controller.v3.share import _visit_response
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.request_schemas.share.create_share_request import VisitShareRequest
from app.services.share import ShareService

router = APIRouter()


def _ok(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _fail(exc: ShareError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.response_code, "msg": str(exc), "data": None},
    )


@router.post("/visit", summary="访问分享快照，用于画布内克隆")
async def visit_share(
    body: VisitShareRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        share = await ShareService.visit_share(
            database=database,
            share_id=body.share_id,
            user_email=user.email,
        )
    except ShareError as exc:
        return _fail(exc)
    return _ok(_visit_response(share))
