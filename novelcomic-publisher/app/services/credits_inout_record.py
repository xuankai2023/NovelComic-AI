"""Credits ledger persistence helpers."""

import logging
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from app.schemas.credits_inout_record import (
    CreditsInoutCreditType,
    CreditsInoutDirection,
    CreditsInoutEventType,
    CreditsInoutRecord,
)

log = logging.getLogger(__name__)


class CreditsInoutRecordService:
    COLLECTION = "credits_inout_record"

    @classmethod
    async def ensure_indexes(cls, database: Any) -> None:
        await _maybe_create_index(
            database[cls.COLLECTION],
            [("idempotency_key", 1)],
            name="credits_inout_record_idempotency_key_uidx",
            unique=True,
            sparse=True,
        )
        await _maybe_create_index(
            database[cls.COLLECTION],
            [("user_id", 1), ("created_at", -1)],
            name="credits_inout_record_user_created_idx",
        )

    @classmethod
    async def safe_create_record(
        cls,
        database: Any,
        record: CreditsInoutRecord,
    ) -> CreditsInoutRecord | None:
        try:
            await database[cls.COLLECTION].insert_one(record.model_dump(mode="json"))
            return record
        except Exception:
            log.exception(
                "Failed to create credits ledger record: user_id=%s idempotency_key=%s",
                record.user_id,
                record.idempotency_key,
            )
            return None

    @classmethod
    async def safe_get_total_balance(
        cls,
        database: Any,
        user_id: str,
    ) -> tuple[int | None, str | None]:
        try:
            return await cls.get_total_balance(database, user_id)
        except Exception:
            log.exception("Failed to read credits balance: user_id=%s", user_id)
            return None, None

    @classmethod
    async def get_total_balance(cls, database: Any, user_id: str) -> tuple[int, str | None]:
        now = datetime.now(UTC)
        user = await database["users"].find_one({"user_id": user_id}) or {}
        subscription = await database["subscription_user_credits"].find_one(
            {"user_id": user_id, "status": "active"}
        )
        gift = await database["gift_credits"].find_one({"user_id": user_id})
        gift_balance = 0
        if gift is not None and _gift_is_active(gift.get("expires_at"), now):
            gift_balance = _safe_int(gift.get("amount"))
        total = (
            _safe_int(user.get("credits"))
            + _safe_int((subscription or {}).get("credits_balance"))
            + gift_balance
        )
        return total, user.get("user_email")

    @classmethod
    async def record_topup_change(
        cls,
        database: Any,
        *,
        user_id: str,
        amount: int,
        source: str,
        balance_before: int,
        balance_after: int,
        user_email: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreditsInoutRecord | None:
        direction: CreditsInoutDirection = "in" if amount > 0 else "out"
        if source == "stripe_payment":
            event_type: CreditsInoutEventType = "recharge"
            reason = "User payment recharge"
        elif source == "feishu_bot":
            event_type = "feishu_topup"
            reason = "Feishu bot topup"
        elif source.startswith("invite_"):
            event_type = "invite_reward"
            reason = "Invite reward"
        elif direction == "in":
            event_type = "admin_topup"
            reason = "Admin topup"
        else:
            event_type = "admin_deduct"
            reason = "Admin deduct"
        return await cls.safe_create_record(
            database,
            _build_record(
                user_id=user_id,
                user_email=user_email,
                credit_type="topup",
                event_type=event_type,
                direction=direction,
                amount=abs(amount),
                balance_before=balance_before,
                balance_after=balance_after,
                reason=reason,
                source=source,
                source_id=idempotency_key,
                idempotency_key=(
                    f"{event_type}:{idempotency_key}" if idempotency_key else None
                ),
                metadata={"source": source, "idempotency_key": idempotency_key},
            ),
        )

    @classmethod
    async def record_subscription_change(
        cls,
        database: Any,
        *,
        user_id: str,
        event_type: CreditsInoutEventType,
        direction: CreditsInoutDirection,
        amount: int,
        balance_before: int,
        balance_after: int,
        user_email: str | None = None,
        source_id: str | None = None,
        idempotency_key: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreditsInoutRecord | None:
        reason = (
            "Subscription credits expired or deactivated"
            if event_type == "subscription_expire"
            else "Subscription credits granted"
        )
        return await cls.safe_create_record(
            database,
            _build_record(
                user_id=user_id,
                user_email=user_email,
                credit_type="subscription",
                event_type=event_type,
                direction=direction,
                amount=abs(amount),
                balance_before=balance_before,
                balance_after=balance_after,
                reason=reason,
                source="subscription",
                source_table="subscription_user_credits",
                source_id=source_id,
                idempotency_key=idempotency_key,
                metadata=metadata or {},
            ),
        )

    @classmethod
    async def record_gift_change(
        cls,
        database: Any,
        *,
        user_id: str,
        event_type: CreditsInoutEventType,
        direction: CreditsInoutDirection,
        amount: int,
        balance_before: int,
        balance_after: int,
        user_email: str | None = None,
        source_id: str | None = None,
        idempotency_key: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreditsInoutRecord | None:
        reason = (
            "Gift credits expired"
            if event_type == "gift_expire"
            else "Official gift credits granted"
        )
        return await cls.safe_create_record(
            database,
            _build_record(
                user_id=user_id,
                user_email=user_email,
                credit_type="gift",
                event_type=event_type,
                direction=direction,
                amount=abs(amount),
                balance_before=balance_before,
                balance_after=balance_after,
                reason=reason,
                source="gift",
                source_table="gift_credits",
                source_id=source_id,
                idempotency_key=idempotency_key,
                metadata=metadata or {},
            ),
        )


def _build_record(
    *,
    user_id: str,
    credit_type: CreditsInoutCreditType,
    event_type: CreditsInoutEventType,
    direction: CreditsInoutDirection,
    amount: int,
    balance_before: int,
    balance_after: int,
    user_email: str | None = None,
    reason: str | None = None,
    source: str | None = None,
    source_table: str | None = None,
    source_id: str | None = None,
    idempotency_key: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> CreditsInoutRecord:
    abs_amount = abs(int(amount or 0))
    signed_amount = abs_amount if direction == "in" else -abs_amount
    return CreditsInoutRecord(
        user_id=user_id,
        user_email=user_email,
        credit_type=credit_type,
        event_type=event_type,
        direction=direction,
        amount=abs_amount,
        signed_amount=signed_amount,
        balance_before=int(balance_before),
        balance_after=int(balance_after),
        reason=reason,
        source=source,
        source_table=source_table,
        source_id=source_id,
        idempotency_key=idempotency_key,
        metadata=metadata or {},
    )


def _safe_int(value: Any) -> int:
    try:
        return int(Decimal(str(value or 0)))
    except (TypeError, ValueError, ArithmeticError):
        return 0


def _gift_is_active(expires_at: Any, now: datetime) -> bool:
    if expires_at is None:
        return True
    if isinstance(expires_at, str):
        expires_at = datetime.fromisoformat(expires_at)
    if not isinstance(expires_at, datetime):
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at > now


async def _maybe_create_index(collection: Any, keys: list[tuple[str, int]], **kwargs: Any) -> None:
    create_index = getattr(collection, "create_index", None)
    if create_index is None:
        return
    await create_index(keys, **kwargs)
