"""Payment endpoints for V1 credits checkout, status, invoice, template, portal, and subscription."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.controller.v2.payments import payment_history as v2_payment_history
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.payments import (
    CreateCheckoutRequestParam,
    CreateSubscriptionCheckoutRequestParam,
    UpdateSubscriptionPlanRequestParam,
)
from app.services.payments import (
    PaymentCheckoutError,
    PaymentsService,
    SubscriptionCheckoutConflictError,
)
from app.services.webhook.stripe_webhook_process_service import StripeWebhookProcessService
from app.utils.stripe_utils import StripeSignatureError, construct_stripe_event

log = logging.getLogger(__name__)

router = APIRouter()
_CLIENT_ERROR = 1000
_CONFLICT = 1009
_UNKNOWN_ERROR = 1007


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.post("/webhook", summary="Stripe Webhook")
async def stripe_payment_webhook(request: Request) -> JSONResponse:
    body = await request.body()
    settings = get_settings()
    try:
        event = construct_stripe_event(
            body,
            request.headers.get("Stripe-Signature"),
            settings.stripe_webhook_secret,
        )
    except StripeSignatureError as error:
        log.warning("Stripe webhook signature rejected: %s", error)
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )

    try:
        result = await StripeWebhookProcessService.process(_database(request), event)
        return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": result})
    except Exception:
        log.exception("Stripe webhook processing error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )


@router.post("/checkout", summary="创建积分充值 Checkout")
async def create_payment_checkout(
    request: Request,
    param: CreateCheckoutRequestParam,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        checkout = await PaymentsService.create_checkout_session(
            _database(request),
            get_settings(),
            param=param,
            user_id=user.user_id,
        )
        return JSONResponse(
            status_code=200,
            content={"code": 200, "msg": "ok", "data": checkout.model_dump(mode="json")},
        )
    except PaymentCheckoutError as error:
        log.warning("Create payment checkout failed: %s", error)
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )
    except Exception:
        log.exception("Create payment checkout error")
        return JSONResponse(
            status_code=500,
            content={"code": _UNKNOWN_ERROR, "msg": "系统错误,请稍后重试", "data": None},
        )


@router.get("/checkout/{session_id}/status", summary="查询 Checkout 会话状态")
async def get_checkout_status(
    session_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    status_data = await PaymentsService.get_checkout_session_status(
        _database(request),
        get_settings(),
        session_id=session_id,
        user_id=user.user_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": status_data})


@router.get("/invoice", summary="查询发票信息")
async def get_payment_invoice(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    session_id: str | None = Query(default=None),
    subscription_id: str | None = Query(default=None),
) -> JSONResponse:
    invoice_data = await PaymentsService.get_invoice_info(
        _database(request),
        get_settings(),
        user_id=user.user_id,
        session_id=session_id,
        subscription_id=subscription_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": invoice_data})


@router.get("/history", summary="获取支付历史 (V1)")
async def get_v1_payment_history(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    return await v2_payment_history(request=request, user=user, page=page, page_size=page_size)


@router.post("/subscription/checkout", summary="创建订阅 Checkout (V1)")
async def create_v1_subscription_checkout(
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
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )


@router.put("/subscription/plan", summary="更新订阅套餐 (V1)")
async def update_v1_subscription_plan(
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
        return JSONResponse(
            status_code=400,
            content={"code": _CLIENT_ERROR, "msg": str(error), "data": None},
        )


@router.get("/subscription/template", summary="获取公开订阅套餐模板")
async def get_subscription_template() -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": PaymentsService.get_subscription_template()},
    )


@router.get("/subscription/stripe_plan_config", summary="获取公开 Stripe 套餐价格配置")
async def get_stripe_plan_config() -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "ok", "data": PaymentsService.get_stripe_plan_config()},
    )


@router.get("/portal_session", summary="创建 Stripe 客户门户会话")
@router.get("/billing_session", summary="创建 Stripe 账单门户会话")
async def get_billing_portal_session(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    return_url: str = Query(default=""),
) -> JSONResponse:
    portal = await PaymentsService.create_billing_portal_session(
        _database(request),
        get_settings(),
        user_id=user.user_id,
        return_url=return_url,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": portal})
