"""Mark local order as failed when Stripe async payment fails."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.order import OrderService

log = logging.getLogger(__name__)


class CheckoutSessionAsyncPaymentFailedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        session = _event_object(event)
        checkout_id = str(session.get("id") or "")
        if not checkout_id:
            return
        order = await OrderService.get_order_by_checkout_id(database, checkout_id)
        if order is None:
            return
        if order.get("pay_status") == "paid":
            return
        await database[OrderService.COLLECTION].update_one(
            {"order_id": order["order_id"]},
            {"$set": {"pay_result": "failed", "updated_at": datetime.now(UTC)}},
        )


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
