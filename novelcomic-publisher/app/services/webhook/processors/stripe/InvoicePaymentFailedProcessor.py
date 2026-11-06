"""Record local payment_failed state when Stripe invoice payment fails."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.subscription_info import SubscriptionInfoService

log = logging.getLogger(__name__)


class InvoicePaymentFailedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        invoice = _event_object(event)
        subscription = invoice.get("subscription")
        subscription_id = (
            subscription.get("id")
            if isinstance(subscription, dict)
            else str(subscription or "")
        )
        if not subscription_id:
            log.info("Stripe invoice payment failure received: event_id=%s", event.get("id"))
            return

        info = await SubscriptionInfoService.get_by_stripe_subscription_id(
            database,
            str(subscription_id),
        )
        if info is None:
            log.info("Failed invoice has no local subscription_info: %s", subscription_id)
            return

        await database[SubscriptionInfoService.COLLECTION].update_one(
            {"id": info["id"]},
            {
                "$set": {
                    "status": "payment_failed",
                    "updated_at": datetime.now(UTC),
                }
            },
        )
        log.info("Marked subscription as payment_failed: %s", subscription_id)


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
