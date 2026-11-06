"""Local subscription_info records paired with paid Stripe subscriptions."""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.schemas.subscription import SubscriptionInfo, SubscriptionMetadata


class SubscriptionInfoService:
    COLLECTION = "subscription_info"

    @classmethod
    def prepare_from_paid_subscription(
        cls,
        *,
        order: dict[str, Any],
        stripe_subscription: dict[str, Any],
        invoice_id: str,
    ) -> dict[str, Any]:
        metadata = _metadata(stripe_subscription.get("metadata"))
        status = str(stripe_subscription.get("status") or "active")
        if status in {"incomplete", "incomplete_expired"}:
            status = "active"
        raw_interval = metadata.get("interval")
        interval = raw_interval if raw_interval in {"monthly", "yearly"} else "monthly"
        info = SubscriptionInfo(
            id=uuid4().hex,
            user_id=str(order["user_id"]),
            stripe_subscription_id=str(stripe_subscription.get("id") or ""),
            stripe_order_id=str(
                stripe_subscription.get("id") or order.get("stripe_order_id") or ""
            ),
            order_id=order.get("order_id"),
            status=status,
            subscription_type="recurring",
            price_ids=_price_ids(stripe_subscription, metadata),
            currency=str(stripe_subscription.get("currency") or order.get("currency") or "usd"),
            start_timestamp=int(stripe_subscription.get("current_period_start") or 0),
            end_timestamp=int(stripe_subscription.get("current_period_end") or 0),
            last_paid_invoice_id=invoice_id,
            subscription_metadata=SubscriptionMetadata(
                user_id=str(order["user_id"]),
                subscription_key=metadata.get("subscription_key") or "",
                interval=interval,
                subscription_credits=int(metadata.get("subscription_credits") or 0),
                level=int(metadata.get("level") or 0),
            ),
        )
        return info.model_dump(mode="json")

    @classmethod
    async def get_by_stripe_subscription_id(
        cls,
        database: Any,
        stripe_subscription_id: str,
    ) -> dict | None:
        document = await database[cls.COLLECTION].find_one(
            {"stripe_subscription_id": stripe_subscription_id}
        )
        return dict(document) if document is not None else None

    @classmethod
    async def upsert(cls, database: Any, info: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(UTC)
        existing = None
        stripe_subscription_id = info.get("stripe_subscription_id")
        if stripe_subscription_id:
            existing = await cls.get_by_stripe_subscription_id(
                database,
                str(stripe_subscription_id),
            )
        if existing is None and info.get("id"):
            document = await database[cls.COLLECTION].find_one({"id": info["id"]})
            existing = dict(document) if document is not None else None

        if existing is not None:
            saved = {**existing, **info, "id": existing["id"], "updated_at": now}
            await database[cls.COLLECTION].update_one({"id": existing["id"]}, {"$set": saved})
            return saved

        saved = {**info, "created_at": now, "updated_at": now}
        if not saved.get("id"):
            saved["id"] = uuid4().hex
        await database[cls.COLLECTION].insert_one(dict(saved))
        return saved


def _metadata(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): "" if item is None else str(item) for key, item in value.items()}


def _price_ids(stripe_subscription: dict[str, Any], metadata: dict[str, str]) -> list[str]:
    price_ids: list[str] = []
    items = (stripe_subscription.get("items") or {}).get("data") or []
    for item in items:
        if not isinstance(item, dict):
            continue
        price = item.get("price")
        if isinstance(price, dict) and price.get("id"):
            price_ids.append(str(price["id"]))
        elif isinstance(price, str) and price:
            price_ids.append(price)
    if not price_ids and metadata.get("price_id"):
        price_ids.append(metadata["price_id"])
    return price_ids
