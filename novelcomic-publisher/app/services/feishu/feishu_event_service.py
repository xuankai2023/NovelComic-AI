"""Handle Feishu event callbacks after the HTTP endpoint has acknowledged them."""

import logging
import re
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument

from app.config import get_settings
from app.schemas.feishu import AddCreditsCommand, FeishuEventCallback, FeishuMessageEvent
from app.services.feishu.feishu_bot_service import FeishuBotService
from app.services.feishu.feishu_message_parser import parse_feishu_text_command
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService

log = logging.getLogger(__name__)

_DEDUP_TTL_SECONDS = 60 * 60 * 8
_PLAN_LEVELS = {"starter": 1, "creator": 2, "pro": 3}


class FeishuEventService:
    @classmethod
    async def process_callback(
        cls,
        *,
        callback: FeishuEventCallback,
        database: Any,
        redis_client: Any,
    ) -> str:
        header = callback.header
        if header is None:
            log.info("Skip Feishu callback without header")
            return "missing header"

        if not cls._verify_token(header.token):
            log.warning("Reject Feishu callback with invalid token: event_id=%s", header.event_id)
            return "invalid token"

        if not await cls._claim_event(redis_client, header.event_id):
            log.info("Skip duplicate Feishu event: event_id=%s", header.event_id)
            return "already processed"

        if header.event_type != "im.message.receive_v1":
            log.info("Skip unsupported Feishu event type: %s", header.event_type)
            return "unsupported event"

        message_event = cls._parse_message_event(callback.event)
        if message_event is None or not cls._should_handle_message(message_event):
            return "ignored message"

        command = parse_feishu_text_command(message_event.message.content)
        if command is None:
            log.info("Feishu text message does not match a supported command")
            return "unknown command"

        if isinstance(command, AddCreditsCommand):
            return await cls._handle_add_credits(
                database,
                command,
                message_event.message.message_id,
            )
        return await cls._handle_update_plan(database, command.email, command.plan)

    @staticmethod
    def _verify_token(token: str) -> bool:
        expected = get_settings().feishu_verification_token
        if not expected:
            log.warning("FEISHU_VERIFICATION_TOKEN is not configured, skip token check")
            return True
        return token == expected

    @staticmethod
    async def _claim_event(redis_client: Any, event_id: str) -> bool:
        key = f"feishu:event:dedup:{event_id}"
        return bool(await redis_client.set(key, "1", ex=_DEDUP_TTL_SECONDS, nx=True))

    @staticmethod
    def _parse_message_event(event: dict[str, Any] | None) -> FeishuMessageEvent | None:
        if not event:
            return None
        try:
            return FeishuMessageEvent.model_validate(event)
        except Exception:
            log.exception("Failed to parse Feishu message event")
            return None

    @staticmethod
    def _should_handle_message(event: FeishuMessageEvent) -> bool:
        if event.sender.sender_type == "app":
            return False
        if event.message.message_type != "text":
            return False
        return bool(event.message.mentions)

    @classmethod
    async def _handle_update_plan(cls, database: Any, email: str, plan: str) -> str:
        user = await cls._find_user_by_email(database, email)
        if not user:
            await FeishuBotService.send_text(f"未找到用户：{email}")
            return "user not found"

        level = _PLAN_LEVELS[plan]
        await database["users"].update_one(
            {"user_id": user["user_id"]},
            {"$set": {"system_level": level, "updated_at": datetime.now(UTC)}},
        )
        await FeishuBotService.send_text(f"{email} 已调整为 {plan}，system_level={level}")
        return "plan updated"

    @classmethod
    async def _handle_add_credits(
        cls,
        database: Any,
        command: AddCreditsCommand,
        message_id: str,
    ) -> str:
        max_credits = get_settings().feishu_max_credits_per_operation
        if command.credits > max_credits:
            await FeishuBotService.send_text(
                f"{command.email} 加积分失败：单次积分不能超过 {max_credits}"
            )
            return "credits exceed limit"

        user = await cls._find_user_by_email(database, command.email)
        if not user:
            await FeishuBotService.send_text(f"未找到用户：{command.email}")
            return "user not found"

        idempotency_key = f"feishu_{message_id}"
        await UnifiedCreditsService.add_topup_credits(
            database,
            user_id=user["user_id"],
            amount=command.credits,
            source="feishu_bot",
            idempotency_key=idempotency_key,
        )
        await cls._safe_create_topup_record(
            database,
            user=user,
            amount=command.credits,
            remark=command.remark,
            message_id=message_id,
            idempotency_key=idempotency_key,
        )
        await FeishuBotService.send_text(
            f"{command.email} 已增加 {command.credits} 积分，备注：{command.remark}"
        )
        return "credits added"

    @staticmethod
    async def _find_user_by_email(database: Any, email: str) -> dict[str, Any] | None:
        normalized = email.strip().lower()
        user = await database["users"].find_one({"user_email": normalized})
        if user:
            return user
        return await database["users"].find_one(
            {"user_email": {"$regex": f"^{re.escape(normalized)}$", "$options": "i"}}
        )

    @staticmethod
    async def _safe_create_topup_record(
        database: Any,
        *,
        user: dict[str, Any],
        amount: int,
        remark: str,
        message_id: str,
        idempotency_key: str,
    ) -> None:
        try:
            await database["credits_topup_record"].find_one_and_update(
                {"idempotency_key": idempotency_key},
                {
                    "$setOnInsert": {
                        "credits_topup_record_id": uuid4().hex,
                        "user_id": user["user_id"],
                        "user_email": user.get("user_email"),
                        "amount": int(amount),
                        "topup_source": "feishu",
                        "source_id": message_id,
                        "idempotency_key": idempotency_key,
                        "remark": remark,
                        "created_at": datetime.now(UTC),
                        "updated_at": datetime.now(UTC),
                    }
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except Exception:
            log.exception("Failed to create Feishu credits topup record")
