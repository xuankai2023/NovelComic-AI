"""Current-user B2B signal actions."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.services.b2b_signal.service import B2BSignalService

router = APIRouter()
_NOT_FOUND = 1010


class MarkShownRequest(BaseModel):
    action_id: str = Field(min_length=1)


@router.get("/pending", summary="获取当前用户 B2B 待展示动作")
async def pending_b2b_actions(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    actions = await B2BSignalService.list_pending_actions(database, user_id=user.user_id)
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": jsonable_encoder(actions)},
    )


@router.post("/shown", summary="标记当前用户 B2B 动作已展示")
async def mark_b2b_action_shown(
    body: MarkShownRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    matched = await B2BSignalService.mark_action_shown(
        database,
        user_id=user.user_id,
        action_id=body.action_id,
    )
    if not matched:
        return JSONResponse(
            status_code=404,
            content={"code": _NOT_FOUND, "msg": "B2B action not found", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": True})
