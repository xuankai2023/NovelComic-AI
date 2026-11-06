"""Clerk user.created / user.deleted 写入本地用户。请求必须通过 Svix 签名。"""

from datetime import UTC, datetime, timedelta
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from svix.webhooks import Webhook, WebhookVerificationError

from app.config import get_settings
from app.services.gift_credits import GiftCreditsService
from app.services.invite import InviteService
from app.services.user import UserService

WELCOME_GIFT_CREDITS_AMOUNT = 500
WELCOME_GIFT_EXPIRE_DAYS = 7

log = logging.getLogger(__name__)

router = APIRouter()


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


def _verify_payload(request: Request, body: bytes) -> dict:
    secret = get_settings().clerk_webhook_secret
    if not secret:
        raise WebhookVerificationError("CLERK_WEBHOOK_SECRET not configured")
    headers = {
        "svix-id": request.headers.get("svix-id", ""),
        "svix-timestamp": request.headers.get("svix-timestamp", ""),
        "svix-signature": request.headers.get("svix-signature", ""),
    }
    if not all(headers.values()):
        raise WebhookVerificationError("Missing webhook signature headers")
    payload = Webhook(secret).verify(body, headers)
    if not isinstance(payload, dict):
        raise WebhookVerificationError("Invalid webhook payload")
    return payload


@router.post("/create", summary="Clerk user.created")
async def clerk_webhook_handler(request: Request) -> JSONResponse:
    body = await request.body()
    try:
        payload = _verify_payload(request, body)
    except WebhookVerificationError as error:
        log.warning("Clerk webhook 签名无效: %s", error)
        return JSONResponse(
            status_code=400,
            content={"code": 1000, "msg": str(error), "data": None},
        )

    event_type = payload.get("type")
    if event_type == "user.deleted":
        data = payload.get("data") or {}
        user_id = data.get("id")
        if user_id:
            database = _database(request)
            await database["users"].update_one(
                {"user_id": user_id},
                {"$set": {"deleted": True, "deleted_at": datetime.now(UTC)}},
            )
        return JSONResponse(
            status_code=200,
            content={"code": 200, "msg": "User deleted event processed", "data": {"user_id": user_id}},
        )

    if event_type != "user.created":
        return JSONResponse(status_code=200, content={"code": 200, "msg": "ignored", "data": None})

    data = payload.get("data") or {}
    user_id = data.get("id")
    if not user_id:
        return JSONResponse(
            status_code=400,
            content={"code": 1000, "msg": "missing user id", "data": None},
        )
    email_addresses = data.get("email_addresses") or []
    user_email = email_addresses[0].get("email_address") if email_addresses else None
    unsafe_metadata = data.get("unsafe_metadata") or {}
    invite_code = unsafe_metadata.get("invite_code") or unsafe_metadata.get("inviteCode")
    fp_hash = unsafe_metadata.get("fpHash") or unsafe_metadata.get("fp_hash")
    fp_time = unsafe_metadata.get("fpTime") or unsafe_metadata.get("fp_time")
    client_ip = unsafe_metadata.get("client_ip")
    source = unsafe_metadata.get("source")
    first_verification = (email_addresses[0].get("verification") or {}) if email_addresses else {}
    is_abnormal_user = bool(
        unsafe_metadata.get("is_abnormal_user")
        or (len(email_addresses) > 1 and first_verification.get("strategy") == "email_code")
    )

    database = _database(request)
    if await UserService.get_user_by_id(database, user_id):
        await InviteService.bind_registered_user(
            database,
            invitee_user_id=user_id,
            invitee_email=user_email,
            invite_code=invite_code,
        )
        log.info("user.created 已存在，跳过: user_id=%s", user_id)
        return JSONResponse(
            status_code=200,
            content={"code": 200, "msg": "User already exists, skip", "data": None},
        )
    await UserService.create_user(
        database,
        user_id,
        user_email,
        first_name=data.get("first_name"),
        last_name=data.get("last_name"),
        fp_hash=fp_hash,
        fp_timezone=fp_time,
        client_ip=client_ip,
        source=source,
        is_abnormal_user=is_abnormal_user,
    )
    if not is_abnormal_user:
        await GiftCreditsService.grant_official_gift(
            database,
            user_id=user_id,
            amount=WELCOME_GIFT_CREDITS_AMOUNT,
            expires_at=datetime.now(UTC) + timedelta(days=WELCOME_GIFT_EXPIRE_DAYS),
            idempotency_key=f"welcome_gift:{user_id}",
            metadata={"reason": "welcome_gift", "ttl_days": WELCOME_GIFT_EXPIRE_DAYS},
        )
    await InviteService.bind_registered_user(
        database,
        invitee_user_id=user_id,
        invitee_email=user_email,
        invite_code=invite_code,
    )
    log.info("本地用户已创建: user_id=%s", user_id)
    return JSONResponse(
        status_code=200,
        content={"code": 200, "msg": "User created event processed", "data": {"user_id": user_id}},
    )
