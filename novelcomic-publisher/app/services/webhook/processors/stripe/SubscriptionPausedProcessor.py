"""Deactivate subscription credits when Stripe pauses the subscription."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.subscription_info import SubscriptionInfoService
from app.services.subscription_management import SubscriptionManagementService

log = logging.getLogger(__name__)


class SubscriptionPausedProcessor:
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
        info["status"] = "paused"
        await database[SubscriptionInfoService.COLLECTION].update_one(
            {"id": info["id"]},
            {"$set": {"status": "paused", "updated_at": datetime.now(UTC)}},
        )
        await SubscriptionManagementService.a_process_subscription_deleted(database, info)


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
