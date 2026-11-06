"""Mark subscription as 3ds_processing when Stripe invoice requires 3DS authentication."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.subscription_info import SubscriptionInfoService

log = logging.getLogger(__name__)


class InvoicePaymentActionRequiredProcessor:
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
            log.info(
                "Stripe invoice.payment_action_required has no subscription: event_id=%s",
                event.get("id"),
            )
            return

        info = await SubscriptionInfoService.get_by_stripe_subscription_id(
            database,
            str(subscription_id),
        )
        if info is None:
            log.info(
                "invoice.payment_action_required has no local subscription_info: %s",
                subscription_id,
            )
            return

        await database[SubscriptionInfoService.COLLECTION].update_one(
            {"id": info["id"]},
            {
                "$set": {
                    "status": "3ds_processing",
                    "updated_at": datetime.now(UTC),
                }
            },
        )
        log.info(
            "Marked subscription as 3ds_processing without granting credits: %s",
            subscription_id,
        )


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
