"""Subscription payment endpoints."""

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.payments import (
    CreateSubscriptionCheckoutRequestParam,
    UpdateSubscriptionPlanRequestParam,
)
from app.services.payments import (
    PaymentCheckoutError,
    PaymentsService,
    SubscriptionCheckoutConflictError,
)

log = logging.getLogger(__name__)

router = APIRouter()
_CLIENT_ERROR = 1000
_CONFLICT = 1009
_UNKNOWN_ERROR = 1007


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.post("/subscription/checkout", summary="创建订阅 Checkout")
async def create_subscription_checkout(
    request: Request,
    param: CreateSubscriptionCheckoutRequestParam,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        checkout = await PaymentsService.create_subscription_checkout_session(
            _database(request),
            get_settings(),
            param=param,
            user_id=user.user_id,
        )
        return JSONResponse(
            status_code=200,
            content={"code": 200, "msg": "ok", "data": checkout.model_dump(mode="json")},
        )
    except SubscriptionCheckoutConflictError as error:
        return JSONResponse(
            status_code=409,
            content={"code": _CONFLICT, "msg": str(error), "data": None},
        )
    except PaymentCheckoutError as error:
        log.warning("Create subscription checkout failed: %s", error)
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )
    except Exception:
        log.exception("Create subscription checkout error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )


@router.put("/subscription/plan", summary="创建套餐变更 Checkout")
async def update_subscription_plan(
    request: Request,
    param: UpdateSubscriptionPlanRequestParam,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        result = await PaymentsService.update_subscription_plan(
            _database(request),
            get_settings(),
            param=param,
            user_id=user.user_id,
        )
        return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": result})
    except SubscriptionCheckoutConflictError as error:
        return JSONResponse(
            status_code=409,
            content={"code": _CONFLICT, "msg": str(error), "data": None},
        )
    except PaymentCheckoutError as error:
        log.warning("Update subscription plan failed: %s", error)
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )
    except Exception:
        log.exception("Update subscription plan error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )


@router.get("/history", summary="获取支付历史")
async def payment_history(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = _database(request)
    query = {"user_id": user.user_id}
    cursor = (
        database["orders"]
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    items = [_serialize_document(item) for item in await _cursor_to_list(cursor, page_size)]
    total = await database["orders"].count_documents(query)
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {"items": items, "total": total, "page": page, "page_size": page_size},
        },
    )


async def _cursor_to_list(cursor, length: int) -> list[dict]:
    if hasattr(cursor, "to_list"):
        return await cursor.to_list(length=length)
    return list(cursor)


def _serialize_document(document: dict) -> dict:
    return {key: _serialize_value(value) for key, value in document.items() if key != "_id"}


def _serialize_value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return _serialize_document(value)
    if isinstance(value, list):
        return [_serialize_value(item) for item in value]
    return value
