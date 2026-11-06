"""Order side effects used by payment processors."""

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument

from app.schemas.subscription import SubscriptionInfo, SubscriptionMetadata
from app.services.invite import InviteService
from app.services.subscription_info import SubscriptionInfoService
from app.services.unified_credits.__base.constants.redis_keys import (
    credits_idempotency_key,
    subscription_user_credits_key,
)
from app.services.unified_credits.credits_cache import (
    CREDITS_IDEMPOTENCY_TTL_SECONDS,
    CreditsCache,
)
from app.services.unified_credits.unified_credits_service import (
    UnifiedCreditsService,
    user_level_from_document,
)

log = logging.getLogger(__name__)

_SETTLEABLE_RESULTS = ("processing", "failed", "payment_failed")
_CLAIMABLE_STATUSES = ("pending", "failed")


class OrderService:
    COLLECTION = "orders"

    @classmethod
    async def reward_invite_for_payment(
        cls,
        database: Any,
        *,
        user_id: str,
        payment_id: str,
        paid_at: datetime | None = None,
    ) -> None:
        await InviteService.reward_paid_user(
            database,
            invitee_user_id=user_id,
            source_id=f"payment:{payment_id}",
            paid_at=paid_at,
        )

    @classmethod
    async def get_order_by_checkout_id(cls, database: Any, checkout_id: str) -> dict | None:
        return await _find_order(database, {"checkout_id": checkout_id})

    @classmethod
    async def get_order_by_order_id(cls, database: Any, order_id: str) -> dict | None:
        return await _find_order(database, {"order_id": order_id})

    @classmethod
    async def get_order_by_stripe_invoice_id(
        cls,
        database: Any,
        stripe_invoice_id: str,
    ) -> dict | None:
        return await _find_order(database, {"stripe_invoice_id": stripe_invoice_id})

    @classmethod
    async def insert_order(cls, database: Any, order: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(UTC)
        document = {
            "order_id": uuid4().hex,
            "fulfillment_status": "pending",
            "pay_result": "processing",
            "pay_status": "unpaid",
            "currency": "usd",
            "amount": 0,
            "created_at": now,
            "updated_at": now,
            **order,
        }
        await database[cls.COLLECTION].insert_one(dict(document))
        return document

    @classmethod
    async def settle_paid_order(
        cls,
        database: Any,
        order_id: str,
        fields: dict[str, Any],
    ) -> dict | None:
        """Move a local order to paid. A repeat delivery returns the already paid order."""
        now = datetime.now(UTC)
        paid_fields = {
            **fields,
            "pay_result": "succeeded",
            "pay_status": "paid",
            "updated_at": now,
        }
        updated = await database[cls.COLLECTION].find_one_and_update(
            {"order_id": order_id, "pay_result": {"$in": list(_SETTLEABLE_RESULTS)}},
            {"$set": paid_fields},
            return_document=ReturnDocument.AFTER,
        )
        if updated is not None:
            return dict(updated)
        current = await cls.get_order_by_order_id(database, order_id)
        if current is not None and current.get("pay_result") == "succeeded":
            return current
        return None

    @classmethod
    async def attach_paid_invoice(
        cls,
        database: Any,
        order: dict[str, Any],
        *,
        stripe_invoice_id: str,
        stripe_subscription_id: str,
        amount: int,
        currency: str,
    ) -> dict[str, Any]:
        fields = {
            "stripe_invoice_id": stripe_invoice_id,
            "stripe_order_id": stripe_subscription_id,
            "amount": int(amount),
            "currency": currency or order.get("currency") or "usd",
            "pay_status": "paid",
            "pay_result": "succeeded",
            "pay_mode": "subscription",
            "type": "recurring",
            "updated_at": datetime.now(UTC),
        }
        await database[cls.COLLECTION].update_one({"order_id": order["order_id"]}, {"$set": fields})
        updated = await cls.get_order_by_order_id(database, order["order_id"])
        return updated or {**order, **fields}

    @classmethod
    async def claim_invoice_fulfillment(cls, database: Any, order_id: str) -> dict | None:
        now = datetime.now(UTC)
        stale_before = now - timedelta(minutes=10)
        token = uuid4().hex
        claimed = await database[cls.COLLECTION].find_one_and_update(
            {
                "order_id": order_id,
                "$or": [
                    {"fulfillment_status": {"$in": list(_CLAIMABLE_STATUSES)}},
                    {"fulfillment_status": None},
                    {
                        "fulfillment_status": "processing",
                        "fulfillment_started_at": {"$lte": stale_before},
                    },
                ],
            },
            {
                "$set": {
                    "fulfillment_status": "processing",
                    "fulfillment_started_at": now,
                    "fulfillment_token": token,
                    "updated_at": now,
                }
            },
            return_document=ReturnDocument.AFTER,
        )
        return dict(claimed) if claimed is not None else None

    @classmethod
    async def mark_invoice_fulfillment(
        cls,
        database: Any,
        *,
        order_id: str,
        status: str,
        fulfillment_token: str,
    ) -> bool:
        now = datetime.now(UTC)
        update: dict[str, Any] = {
            "$set": {"fulfillment_status": status, "updated_at": now},
            "$unset": {"fulfillment_token": ""},
        }
        if status == "completed":
            update["$set"]["fulfilled_at"] = now
        result = await database[cls.COLLECTION].update_one(
            {
                "order_id": order_id,
                "fulfillment_status": "processing",
                "fulfillment_token": fulfillment_token,
            },
            update,
        )
        matched = getattr(result, "matched_count", None)
        if matched is None:
            matched = getattr(result, "modified_count", 0)
        return matched == 1

    @classmethod
    async def _process_completed_order_for_payment_v2(
        cls,
        database: Any,
        order: dict[str, Any],
    ) -> None:
        user_id = str(order["user_id"])
        user = await database["users"].find_one({"user_id": user_id})
        await UnifiedCreditsService.add_topup_credits_from_payment(
            database,
            user_id=user_id,
            payment_amount_cents=int(order.get("amount") or 0),
            user_level=user_level_from_document(user),
            idempotency_key=str(order["order_id"]),
        )

    @classmethod
    async def process_one_time_subscription_order(
        cls,
        database: Any,
        *,
        order: dict[str, Any],
        metadata: dict[str, Any],
    ) -> None:
        """Grant subscription credits for a one-time yearly checkout. Do not convert cents."""
        credits = int(metadata.get("subscription_credits") or 0)
        if credits <= 0:
            raise RuntimeError("One-time subscription is missing subscription credits")

        user_id = str(order["user_id"])
        order_id = str(order["order_id"])
        grant_id = f"one_time_order:{order_id}"
        credits_collection = database["subscription_user_credits"]
        existing = await credits_collection.find_one({"credit_grant_id": grant_id})
        if existing is not None:
            await CreditsCache.delete(subscription_user_credits_key(user_id))
            return

        acquired = await CreditsCache.set_if_absent(
            credits_idempotency_key(order_id),
            "1",
            CREDITS_IDEMPOTENCY_TTL_SECONDS,
        )
        if not acquired:
            existing = await credits_collection.find_one({"credit_grant_id": grant_id})
            if existing is not None:
                await CreditsCache.delete(subscription_user_credits_key(user_id))
                return
            raise RuntimeError("One-time subscription fulfillment is already in progress")

        try:
            raw_interval = metadata.get("interval")
            interval = raw_interval if raw_interval in {"monthly", "yearly"} else "yearly"
            now = datetime.now(UTC)
            end = now + timedelta(days=365 if interval == "yearly" else 30)
            subscription_id = "one_time_" + hashlib.sha256(order_id.encode()).hexdigest()[:32]
            info = SubscriptionInfo(
                id=subscription_id,
                user_id=user_id,
                stripe_subscription_id=subscription_id,
                stripe_order_id=str(order.get("stripe_order_id") or order.get("checkout_id") or ""),
                order_id=order_id,
                status="active",
                subscription_type="one_time",
                price_ids=[str(metadata["price_id"])] if metadata.get("price_id") else [],
                currency=str(order.get("currency") or "usd"),
                start_timestamp=int(now.timestamp()),
                end_timestamp=int(end.timestamp()),
                subscription_metadata=SubscriptionMetadata(
                    user_id=user_id,
                    subscription_key=str(metadata.get("subscription_key") or ""),
                    interval=interval,
                    subscription_credits=credits,
                    level=int(metadata.get("level") or 0),
                ),
            )
            saved = await SubscriptionInfoService.upsert(database, info.model_dump(mode="json"))
            await UnifiedCreditsService.deactivate_subscription_credits(database, user_id=user_id)
            await UnifiedCreditsService.save_subscription_credits(
                database,
                {
                    "credit_grant_id": grant_id,
                    "subscription_info_id": saved["id"],
                    "user_id": user_id,
                    "stripe_subscription_id": saved.get("stripe_subscription_id"),
                    "cycle_number": 1,
                    "credits_balance": credits,
                    "status": "active",
                },
            )
            log.info(
                "Fulfilled one-time subscription: user_id=%s order_id=%s credits=%s",
                user_id,
                order_id,
                credits,
            )
        except Exception:
            existing_grant = await credits_collection.find_one({"credit_grant_id": grant_id})
            if existing_grant is None:
                await CreditsCache.delete_quietly(credits_idempotency_key(order_id))
            raise


async def _find_order(database: Any, query: dict[str, Any]) -> dict | None:
    document = await database[OrderService.COLLECTION].find_one(query)
    return dict(document) if document is not None else None
