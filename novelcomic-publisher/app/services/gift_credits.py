"""Gift credits grant, expiry and notification helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from app.services.credits_inout_record import CreditsInoutRecordService
from app.services.unified_credits.__base.constants.redis_keys import gift_credits_key
from app.services.unified_credits.credits_cache import CreditsCache

DEFAULT_GIFT_TTL_DAYS = 30


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(int(value), tz=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _expires_at(document: dict[str, Any]) -> datetime | None:
    return _to_datetime(document.get("expires_at") or document.get("expire_timestamp"))


class GiftCreditsService:
    COLLECTION = "gift_credits"

    @classmethod
    async def get_gift_credits(
        cls,
        database: Any,
        *,
        user_id: str,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        document = await database[cls.COLLECTION].find_one({"user_id": user_id})
        if not document:
            return None
        current = now or datetime.now(UTC)
        expires_at = _expires_at(document)
        if expires_at is not None and expires_at <= current:
            await cls.expire_gift_credits(database, user_id=user_id, document=document)
            return None
        document.pop("_id", None)
        return document

    @classmethod
    async def grant_official_gift(
        cls,
        database: Any,
        *,
        user_id: str,
        amount: int,
        expires_at: datetime | None = None,
        gift_credit_id: str | None = None,
        idempotency_key: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        amount = _safe_int(amount)
        if amount <= 0:
            raise ValueError("gift amount must be positive")
        gift_credit_id = gift_credit_id or uuid4().hex
        expires_at = expires_at or (datetime.now(UTC) + timedelta(days=DEFAULT_GIFT_TTL_DAYS))
        if idempotency_key:
            existing = await database[cls.COLLECTION].find_one(
                {"idempotency_key": idempotency_key}
            )
            if existing:
                existing.pop("_id", None)
                return existing

        balance_before, user_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        now = datetime.now(UTC)
        document = {
            "gift_credit_id": gift_credit_id,
            "user_id": user_id,
            "amount": amount,
            "notify_status": "not_notified",
            "received_at": now,
            "expires_at": expires_at,
            "idempotency_key": idempotency_key,
            "metadata": metadata or {},
            "created_at": now,
            "updated_at": now,
        }
        existing_for_user = await database[cls.COLLECTION].find_one({"user_id": user_id})
        if existing_for_user:
            await database[cls.COLLECTION].update_one(
                {"user_id": user_id},
                {"$set": document},
            )
        else:
            await database[cls.COLLECTION].insert_one(document)

        await CreditsCache.delete_quietly(gift_credits_key(user_id))
        balance_after, refreshed_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        if balance_before is not None and balance_after is not None:
            await CreditsInoutRecordService.record_gift_change(
                database,
                user_id=user_id,
                user_email=user_email or refreshed_email,
                event_type="official_gift",
                direction="in",
                amount=amount,
                balance_before=balance_before,
                balance_after=balance_after,
                source_id=gift_credit_id,
                idempotency_key=f"official_gift:{idempotency_key or gift_credit_id}",
                metadata=metadata or {},
            )
        document.pop("_id", None)
        return document

    @classmethod
    async def expire_gift_credits(
        cls,
        database: Any,
        *,
        user_id: str,
        document: dict[str, Any] | None = None,
    ) -> None:
        document = document or await database[cls.COLLECTION].find_one({"user_id": user_id})
        if not document or document.get("status") == "expired":
            return
        amount = _safe_int(document.get("amount"))
        gift_credit_id = str(document.get("gift_credit_id") or user_id)
        await database[cls.COLLECTION].update_one(
            {"user_id": user_id},
            {"$set": {"amount": 0, "status": "expired", "updated_at": datetime.now(UTC)}},
        )
        await CreditsCache.delete_quietly(gift_credits_key(user_id))
        balance_after, user_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        if amount > 0:
            await CreditsInoutRecordService.record_gift_change(
                database,
                user_id=user_id,
                user_email=user_email,
                event_type="gift_expire",
                direction="out",
                amount=amount,
                balance_before=(balance_after or 0) + amount,
                balance_after=balance_after or 0,
                source_id=gift_credit_id,
                idempotency_key=f"gift_expire:{gift_credit_id}",
                metadata={"gift_credit_id": gift_credit_id},
            )

    @classmethod
    async def notify_user_gift_credits(cls, database: Any, *, user_id: str) -> None:
        await database[cls.COLLECTION].update_one(
            {"user_id": user_id},
            {"$set": {"notify_status": "notified", "updated_at": datetime.now(UTC)}},
        )
