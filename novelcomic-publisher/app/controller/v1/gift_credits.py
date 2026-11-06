"""Gift credits endpoints."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.services.gift_credits import GiftCreditsService

log = logging.getLogger(__name__)

router = APIRouter()
_CLIENT_ERROR = 1000
_UNKNOWN_ERROR = 1007


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.get("", summary="查询当前用户赠送积分")
async def get_gift_credits(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        gift_credits = await GiftCreditsService.get_gift_credits(
            _database(request),
            user_id=user.user_id,
        )
        return JSONResponse(
            status_code=200,
            content={"code": 200, "msg": "ok", "data": jsonable_encoder(gift_credits)},
        )
    except Exception:
        log.exception("Get gift credits error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )


@router.patch("/notify", summary="标记赠送积分已提醒")
async def notified_user_gift_credits(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        await GiftCreditsService.notify_user_gift_credits(
            _database(request),
            user_id=user.user_id,
        )
        return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": None})
    except ValueError as error:
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )
    except Exception:
        log.exception("Notify gift credits error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )
