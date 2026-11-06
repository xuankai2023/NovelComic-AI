"""Deactivate subscription credits when Stripe deletes the subscription."""

import logging
from typing import Any

from app.services.subscription_info import SubscriptionInfoService
from app.services.subscription_management import SubscriptionManagementService

log = logging.getLogger(__name__)

_PROTECTED_HOLD_STATUSES = {"upgrading", "3ds_processing", "processing", "pending_confirmation"}


class SubscriptionDeletedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        subscription = _event_object(event)
        subscription_id = subscription.get("id")
        if not subscription_id:
            log.info(
                "Stripe subscription deletion has no subscription: event_id=%s",
                event.get("id"),
            )
            return
        info = await SubscriptionInfoService.get_by_stripe_subscription_id(
            database,
            str(subscription_id),
        )
        if info is None:
            log.info("Deleted Stripe subscription has no local record: %s", subscription_id)
            return
        if info.get("status") in _PROTECTED_HOLD_STATUSES:
            log.info(
                "Skipping credit deactivation for subscription in protected status %s: %s",
                info.get("status"),
                subscription_id,
            )
            return
        info["status"] = "canceled"
        await SubscriptionManagementService.a_process_subscription_deleted(database, info)


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
