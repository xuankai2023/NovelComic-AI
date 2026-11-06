"""Mongo-backed unified credits service."""

import logging
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument

from app.services.credits_inout_record import CreditsInoutRecordService
from app.services.unified_credits.__base.constants.redis_keys import (
    credit_balance_check_key,
    credits_idempotency_key,
    subscription_user_credits_key,
)
from app.services.unified_credits.credits_cache import (
    CREDITS_IDEMPOTENCY_TTL_SECONDS,
    CreditsCache,
)
from app.services.unified_credits.schemas import (
    GiftCredits,
    SubscriptionCredits,
    UserCreditsSnapshot,
)

log = logging.getLogger(__name__)

DEFAULT_TOPUP_CREDITS_PER_DOLLAR = 400
PRO_TOPUP_CREDITS_PER_DOLLAR = 500


def user_level_from_document(user: dict | None) -> int:
    """Level 3 is the pro rate. The user document stores this as system_level."""
    if not user:
        return 0
    raw = user.get("system_level", user.get("user_level", 0))
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def _without_id(document: dict | None) -> dict | None:
    if document is None:
        return None
    result = dict(document)
    result.pop("_id", None)
    return result


class UnifiedCreditsService:
    USERS = "users"
    SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
    GIFT_CREDITS = "gift_credits"

    @classmethod
    async def get_user_credits_snapshot(
        cls,
        database: Any,
        user_id: str,
        *,
        now: datetime | None = None,
    ) -> UserCreditsSnapshot:
        current_time = now or datetime.now(UTC)
        user = _without_id(await database[cls.USERS].find_one({"user_id": user_id})) or {}
        topup_credits = Decimal(str(user.get("credits") or 0))

        subscription_doc = _without_id(
            await database[cls.SUBSCRIPTION_USER_CREDITS].find_one(
                {"user_id": user_id, "status": "active"}
            )
        )
        if subscription_doc is None:
            subscription_doc = _without_id(
                await database[cls.SUBSCRIPTION_USER_CREDITS].find_one({"user_id": user_id})
            )
        subscription = SubscriptionCredits(**subscription_doc) if subscription_doc else None

        gift_doc = _without_id(await database[cls.GIFT_CREDITS].find_one({"user_id": user_id}))
        gift = GiftCredits(**gift_doc) if gift_doc else None
        if gift is not None and not gift.is_active(current_time):
            gift = None

        return UserCreditsSnapshot(
            user_id=user_id,
            topup_credits=topup_credits,
            subscription_credits=subscription,
            gift_credits=gift,
        )

    @classmethod
    async def ensure_indexes(cls, database: Any) -> None:
        """Create indexes used by the first payment ledger slice."""
        await _maybe_create_index(
            database[cls.SUBSCRIPTION_USER_CREDITS],
            [("user_id", 1), ("status", 1)],
            name="subscription_user_credits_user_status_idx",
        )
        await _maybe_create_index(
            database[cls.GIFT_CREDITS],
            [("user_id", 1), ("expires_at", 1)],
            name="gift_credits_user_expires_idx",
        )
        await _maybe_create_index(
            database[cls.SUBSCRIPTION_USER_CREDITS],
            [("credit_grant_id", 1)],
            name="subscription_user_credits_grant_uidx",
            unique=True,
            sparse=True,
        )

    @classmethod
    async def add_topup_credits_from_payment(
        cls,
        database: Any,
        *,
        user_id: str,
        payment_amount_cents: int,
        user_level: int,
        idempotency_key: str,
    ) -> int:
        """Convert a settled payment into top-up credits. Level 3 earns 500 per dollar."""
        credits_per_dollar = (
            PRO_TOPUP_CREDITS_PER_DOLLAR
            if user_level == 3
            else DEFAULT_TOPUP_CREDITS_PER_DOLLAR
        )
        credits_amount = (int(payment_amount_cents) * credits_per_dollar) // 100
        log.info(
            "Top-up conversion: user_id=%s cents=%s level=%s credits=%s",
            user_id,
            payment_amount_cents,
            user_level,
            credits_amount,
        )
        if credits_amount <= 0:
            return 0
        await cls.add_topup_credits(
            database,
            user_id=user_id,
            amount=credits_amount,
            source="stripe_payment",
            idempotency_key=idempotency_key,
        )
        return credits_amount

    @classmethod
    async def add_topup_credits(
        cls,
        database: Any,
        *,
        user_id: str,
        amount: int,
        source: str,
        idempotency_key: str | None = None,
    ) -> None:
        """Add top-up credits once. Release the idempotency lock only if Mongo did not commit."""
        if amount == 0:
            return

        lock_acquired = False
        if idempotency_key:
            lock_acquired = await CreditsCache.set_if_absent(
                credits_idempotency_key(idempotency_key),
                "1",
                CREDITS_IDEMPOTENCY_TTL_SECONDS,
            )
            if not lock_acquired:
                log.info(
                    "Skip duplicate top-up: user_id=%s idempotency_key=%s",
                    user_id,
                    idempotency_key,
                )
                return

        mongo_write_success = False
        try:
            balance_before, user_email = await CreditsInoutRecordService.safe_get_total_balance(
                database,
                user_id,
            )
            await _coerce_null_credits(database, user_id)
            users_col = database[cls.USERS]
            find_one_and_update = getattr(users_col, "find_one_and_update", None)
            if callable(find_one_and_update):
                updated = await find_one_and_update(
                    {"user_id": user_id},
                    {"$inc": {"credits": int(amount)}},
                    return_document=ReturnDocument.AFTER,
                )
            else:
                existing_user = await users_col.find_one({"user_id": user_id})
                if existing_user is None:
                    updated = None
                else:
                    new_credits = int(existing_user.get("credits") or 0) + int(amount)
                    await users_col.update_one(
                        {"user_id": user_id},
                        {"$set": {"credits": new_credits}},
                    )
                    updated = {**existing_user, "credits": new_credits}
            if updated is None:
                raise RuntimeError(f"User not found: {user_id}")
            mongo_write_success = True

            try:
                await CreditsCache.delete(credit_balance_check_key(user_id))
            except Exception:
                log.warning(
                    "Top-up cache delete failed; keeping idempotency lock: user_id=%s",
                    user_id,
                    exc_info=True,
                )

            balance_after, refreshed_email = await CreditsInoutRecordService.safe_get_total_balance(
                database,
                user_id,
            )
            if balance_before is not None and balance_after is not None:
                await CreditsInoutRecordService.record_topup_change(
                    database,
                    user_id=user_id,
                    user_email=user_email or refreshed_email,
                    amount=int(amount),
                    source=source,
                    balance_before=balance_before,
                    balance_after=balance_after,
                    idempotency_key=idempotency_key,
                )
        except Exception:
            if lock_acquired and not mongo_write_success and idempotency_key:
                log.warning(
                    "Top-up failed before Mongo commit; releasing idempotency lock: %s",
                    idempotency_key,
                )
                await CreditsCache.delete_quietly(credits_idempotency_key(idempotency_key))
            raise

    @classmethod
    async def save_subscription_credits(
        cls,
        database: Any,
        credits: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert one subscription-credit grant, then drop the subscription balance cache."""
        user_id = str(credits["user_id"])
        document = dict(credits)
        document.setdefault("id", uuid4().hex)
        document.setdefault("status", "active")
        document["credits_balance"] = int(document.get("credits_balance") or 0)
        document["updated_at"] = datetime.now(UTC)
        document.setdefault("created_at", document["updated_at"])

        balance_before, user_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        await database[cls.SUBSCRIPTION_USER_CREDITS].insert_one(document)
        balance_after, refreshed_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        if balance_before is not None and balance_after is not None:
            amount = max(0, balance_after - balance_before)
            if amount > 0:
                event_type = (
                    "subscription_monthly_renew"
                    if int(document.get("cycle_number") or 1) > 1
                    else "subscription_grant"
                )
                grant_key = document.get("credit_grant_id") or document["id"]
                await CreditsInoutRecordService.record_subscription_change(
                    database,
                    user_id=user_id,
                    user_email=user_email or refreshed_email,
                    event_type=event_type,
                    direction="in",
                    amount=amount,
                    balance_before=balance_before,
                    balance_after=balance_after,
                    source_id=str(document.get("id")),
                    idempotency_key=f"{event_type}:{grant_key}",
                    metadata={
                        "subscription_info_id": document.get("subscription_info_id"),
                        "cycle_number": document.get("cycle_number") or 1,
                    },
                )

        try:
            await CreditsCache.delete(subscription_user_credits_key(user_id))
        except Exception:
            log.warning(
                "Subscription credit cache delete failed after Mongo write: user_id=%s",
                user_id,
                exc_info=True,
            )
            raise
        return document

    @classmethod
    async def deactivate_subscription_credits(
        cls,
        database: Any,
        *,
        user_id: str,
        subscription_info_id: str | None = None,
    ) -> int:
        """Mark matching subscription credits canceled so they leave the available total."""
        query: dict[str, Any] = {"user_id": user_id, "status": "active"}
        if subscription_info_id:
            query["subscription_info_id"] = subscription_info_id

        balance_before, user_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        canceled_ids: list[str] = []
        canceled_amount = 0
        while True:
            updated = await database[cls.SUBSCRIPTION_USER_CREDITS].find_one_and_update(
                query,
                {"$set": {"status": "canceled", "updated_at": datetime.now(UTC)}},
                return_document=ReturnDocument.AFTER,
            )
            if updated is None:
                break
            canceled_ids.append(str(updated.get("id") or updated.get("credit_grant_id") or ""))
            canceled_amount += int(updated.get("credits_balance") or 0)

        try:
            await CreditsCache.delete(subscription_user_credits_key(user_id))
        except Exception:
            log.warning(
                "Subscription credit cache delete failed during deactivation: user_id=%s",
                user_id,
                exc_info=True,
            )

        balance_after, refreshed_email = await CreditsInoutRecordService.safe_get_total_balance(
            database,
            user_id,
        )
        if (
            canceled_amount > 0
            and balance_before is not None
            and balance_after is not None
            and canceled_ids
        ):
            await CreditsInoutRecordService.record_subscription_change(
                database,
                user_id=user_id,
                user_email=user_email or refreshed_email,
                event_type="subscription_expire",
                direction="out",
                amount=max(canceled_amount, balance_before - balance_after, 0),
                balance_before=balance_before,
                balance_after=balance_after,
                source_id=subscription_info_id or user_id,
                idempotency_key="subscription_expire:" + ",".join(sorted(canceled_ids)),
                metadata={"subscription_info_id": subscription_info_id},
            )
        return canceled_amount


async def _coerce_null_credits(database: Any, user_id: str) -> None:
    collection = database["users"]
    await collection.update_one(
        {"user_id": user_id, "credits": None},
        {"$set": {"credits": 0}},
    )


async def _maybe_create_index(collection: Any, keys: list[tuple[str, int]], **kwargs: Any) -> None:
    create_index = getattr(collection, "create_index", None)
    if create_index is None:
        return
    await create_index(keys, **kwargs)
