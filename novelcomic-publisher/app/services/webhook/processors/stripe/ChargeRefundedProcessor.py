"""Record refund status on local order without deducting credits."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.order import OrderService

log = logging.getLogger(__name__)


class ChargeRefundedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        charge = _event_object(event)
        payment_intent = charge.get("payment_intent")
        intent_id = (
            payment_intent.get("id")
            if isinstance(payment_intent, dict)
            else str(payment_intent or "")
        )
        if not intent_id:
            return
        order = await database[OrderService.COLLECTION].find_one({"stripe_order_id": intent_id})
        if order is None:
            return
        await database[OrderService.COLLECTION].update_one(
            {"order_id": order["order_id"]},
            {"$set": {"refunded": True, "updated_at": datetime.now(UTC)}},
        )


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
