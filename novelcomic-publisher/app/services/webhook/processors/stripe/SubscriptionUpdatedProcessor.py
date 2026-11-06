"""Sync local subscription_info projection when Stripe updates a subscription."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.subscription_info import SubscriptionInfoService

log = logging.getLogger(__name__)


class SubscriptionUpdatedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        subscription = _event_object(event)
        subscription_id = subscription.get("id")
        if not subscription_id:
            return
        info = await SubscriptionInfoService.get_by_stripe_subscription_id(
            database,
            str(subscription_id),
        )
        if info is None:
            return
        updates: dict[str, Any] = {"updated_at": datetime.now(UTC)}
        if subscription.get("status"):
            updates["status"] = str(subscription["status"])
        if subscription.get("current_period_start"):
            updates["start_timestamp"] = int(subscription["current_period_start"])
        if subscription.get("current_period_end"):
            updates["end_timestamp"] = int(subscription["current_period_end"])
        await database[SubscriptionInfoService.COLLECTION].update_one(
            {"id": info["id"]},
            {"$set": updates},
        )


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
