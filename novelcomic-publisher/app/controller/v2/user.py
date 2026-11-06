"""当前登录用户的本地资料。必须先过 JWT。"""

import logging
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.services.invite import InviteService
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService
from app.services.user import UserService

log = logging.getLogger(__name__)

router = APIRouter()
_NOT_FOUND = 1010


@router.get("/info", summary="获取用户信息")
async def user_info_v2(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    current = await UserService.get_user_by_id(database, user.user_id)
    if current is None:
        log.error("User not found in database: %s", user.user_id)
        return JSONResponse(
            status_code=404,
            content={
                "code": _NOT_FOUND,
                "msg": f"User not found: {user.user_id}",
                "data": None,
            },
        )
    invite_summary = await InviteService.get_summary(database, user.user_id)
    current["invite_summary"] = invite_summary.model_dump(mode="json")
    snapshot = await UnifiedCreditsService.get_user_credits_snapshot(database, user.user_id)
    current["credits"] = _json_number(snapshot.topup_credits)
    current["subscription_credits"] = (
        snapshot.subscription_credits.model_dump(mode="json")
        if snapshot.subscription_credits is not None
        else None
    )
    current["gift_credits"] = (
        snapshot.gift_credits.model_dump(mode="json") if snapshot.gift_credits is not None else None
    )
    current["total_credits"] = _json_number(snapshot.total_credits)
    current["subscription_billing_state"] = await _get_subscription_billing_state(
        database,
        user.user_id,
    )
    sub_doc = await database["subscription_infos"].find_one(
        {"user_id": user.user_id, "status": {"$in": ["active", "trialing"]}},
        {"_id": 0},
    )
    current["subscription"] = sub_doc
    has_3ds = await database["orders"].find_one(
        {"user_id": user.user_id, "pay_mode": "subscription", "pay_result": "3ds_processing"}
    )
    current["has_3ds_subscriptions"] = has_3ds is not None
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": current})


@router.patch("/preferences", summary="更新用户偏好设置")
@router.post("/preferences", summary="更新用户偏好设置")
async def update_user_preferences_v2(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    prefs = await UserService.update_preferences(database, user.user_id, body)
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": {"preferences": prefs}},
    )


@router.get("/invitees", summary="获取邀请用户明细")
@router.get("/invite/invitees", summary="获取邀请用户明细")
async def user_invitees_v2(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    data = await InviteService.list_invitees(
        database,
        user.user_id,
        page=page,
        page_size=page_size,
    )
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": data.model_dump(mode="json")},
    )


def _json_number(value: Decimal) -> int | float:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


async def _get_subscription_billing_state(database, user_id: str) -> dict[str, str | bool | None]:
    failed_payment = await database["orders"].find_one(
        {"user_id": user_id, "pay_mode": "subscription", "pay_result": "payment_failed"}
    )
    if failed_payment is not None:
        return {"checkout_eligible": False, "reason": "payment_requires_resolution"}

    active_subscription = await database["subscription_user_credits"].find_one(
        {"user_id": user_id, "status": "active"}
    )
    if active_subscription is not None:
        return {"checkout_eligible": False, "reason": "active_subscription"}

    processing_checkout = await database["orders"].find_one(
        {"user_id": user_id, "pay_mode": "subscription", "pay_result": "processing"}
    )
    if processing_checkout is not None:
        return {"checkout_eligible": False, "reason": "checkout_in_progress"}

    return {"checkout_eligible": True, "reason": None}


@router.get("/invite-credits", summary="获取邀请积分明细")
@router.get("/invite/credits", summary="获取邀请积分明细")
async def user_invite_credits_v2(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    data = await InviteService.list_credit_records(
        database,
        user.user_id,
        page=page,
        page_size=page_size,
    )
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": data.model_dump(mode="json")},
    )
