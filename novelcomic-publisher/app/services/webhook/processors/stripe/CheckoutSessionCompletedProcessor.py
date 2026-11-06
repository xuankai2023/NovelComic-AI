"""Fulfill settled one-time Checkout Sessions."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings
from app.services.b2b_signal.instrumentation import emit_payment_succeeded
from app.services.order import OrderService
from app.utils.stripe_utils import (
    retrieve_stripe_checkout_session,
    retrieve_stripe_payment_intent,
)
from app.utils.lark_notify import send_custom_workflow_order_notification

log = logging.getLogger(__name__)

_SETTLED_PAYMENT_STATUSES = {"paid", "no_payment_required"}


class CheckoutSessionCompletedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        session = _event_object(event)
        checkout_id = session.get("id")
        if not checkout_id:
            log.info("Stripe checkout completion has no session: event_id=%s", event.get("id"))
            return
        if event.get("type") == "checkout.session.async_payment_succeeded":
            session = await retrieve_stripe_checkout_session(str(checkout_id))

        mode = session.get("mode")
        if mode == "payment":
            await cls._process_payment(database, event, session)
            return
        if mode == "subscription":
            await cls._mark_subscription_checkout_settled(database, session)
            return
        log.info("Ignoring checkout session with unsupported mode=%s", mode)

    @classmethod
    async def _process_payment(
        cls,
        database: Any,
        event: dict[str, Any],
        session: dict[str, Any],
    ) -> None:
        checkout_id = str(session["id"])
        payment_intent = session.get("payment_intent")
        payment_metadata = await _payment_metadata(session, payment_intent)
        if not _payment_is_settled(session, payment_intent):
            if event.get("type") == "checkout.session.async_payment_succeeded":
                raise RuntimeError(
                    "Stripe reported async payment success but the Checkout Session "
                    f"is not settled yet: {checkout_id}"
                )
            log.info(
                "Checkout payment is not settled: checkout_id=%s payment_status=%s",
                checkout_id,
                session.get("payment_status"),
            )
            return
        if payment_metadata.get("payment_type") == "custom_workflow":
            await cls._process_custom_workflow_payment(database, session, payment_metadata)
            return

        order = await _find_checkout_order(database, session, payment_metadata)
        if order is None:
            log.warning("Checkout order was not found: checkout_id=%s", checkout_id)
            return

        amount = session.get("amount_total")
        if amount is None:
            amount = order.get("amount") or 0
        intent_id = payment_intent.get("id") if isinstance(payment_intent, dict) else payment_intent
        settled = await OrderService.settle_paid_order(
            database,
            str(order["order_id"]),
            {
                "amount": int(amount),
                "currency": str(session.get("currency") or order.get("currency") or "usd"),
                "stripe_order_id": str(intent_id or checkout_id),
                "checkout_id": checkout_id,
            },
        )
        if settled is None:
            log.info("Checkout order was not moved to paid: checkout_id=%s", checkout_id)
            return
        await _fulfill_claimed_order(
            database,
            settled,
            payment_metadata,
            payment_id=str(intent_id or checkout_id),
        )

    @classmethod
    async def _mark_subscription_checkout_settled(
        cls,
        database: Any,
        session: dict[str, Any],
    ) -> None:
        """A subscription Checkout does not grant credits. The paid invoice does."""
        order = await OrderService.get_order_by_checkout_id(database, str(session["id"]))
        if order is None:
            log.warning(
                "Subscription checkout order was not found: checkout_id=%s",
                session.get("id"),
            )
            return
        subscription_id = session.get("subscription")
        if isinstance(subscription_id, dict):
            subscription_id = subscription_id.get("id")
        fields: dict[str, Any] = {}
        if subscription_id:
            fields["stripe_order_id"] = str(subscription_id)
        await OrderService.settle_paid_order(database, str(order["order_id"]), fields)
        log.info(
            "Subscription checkout completed; waiting for the paid invoice: checkout_id=%s",
            session.get("id"),
        )

    @classmethod
    async def _process_custom_workflow_payment(
        cls,
        database: Any,
        session: dict[str, Any],
        metadata: dict[str, Any],
    ) -> None:
        checkout_id = str(session["id"])
        order = await _find_checkout_order(database, session, metadata)
        if order is None:
            log.warning("Custom workflow order was not found: checkout_id=%s", checkout_id)
            return

        amount = session.get("amount_total")
        if amount is None:
            amount = order.get("amount") or 0
        payment_intent = session.get("payment_intent")
        intent_id = payment_intent.get("id") if isinstance(payment_intent, dict) else payment_intent
        settled = await OrderService.settle_paid_order(
            database,
            str(order["order_id"]),
            {
                "amount": int(amount),
                "currency": str(session.get("currency") or order.get("currency") or "usd"),
                "stripe_order_id": str(intent_id or checkout_id),
                "checkout_id": checkout_id,
                "service_type": metadata.get("service_type")
                or order.get("service_type")
                or order.get("custom_workflow_service_type")
                or "custom_workflow",
                "customer_email": session.get("customer_email") or order.get("customer_email") or "",
                "paid_at": datetime.now(UTC),
            },
        )
        if settled is None:
            log.info("Custom workflow order was not moved to paid: checkout_id=%s", checkout_id)
            return

        await send_custom_workflow_order_notification(settled)
        log.info(
            "Custom workflow checkout completed without credits fulfillment: checkout_id=%s order_id=%s",
            checkout_id,
            settled.get("order_id"),
        )


async def _fulfill_claimed_order(
    database: Any,
    order: dict[str, Any],
    metadata: dict[str, Any],
    *,
    payment_id: str,
) -> None:
    claimed = await OrderService.claim_invoice_fulfillment(database, str(order["order_id"]))
    if claimed is None:
        current = await OrderService.get_order_by_order_id(database, str(order["order_id"]))
        status = (current or {}).get("fulfillment_status")
        log.info(
            "Checkout fulfillment was not claimed: order_id=%s fulfillment_status=%s",
            order.get("order_id"),
            status,
        )
        return

    token = str(claimed.get("fulfillment_token") or "")
    if not token:
        raise RuntimeError(
            f"Checkout fulfillment claim has no fencing token: {order.get('order_id')}"
        )
    try:
        if metadata.get("is_subscription_purchase") == "true":
            await OrderService.process_one_time_subscription_order(
                database,
                order=order,
                metadata=metadata,
            )
        else:
            await OrderService._process_completed_order_for_payment_v2(database, order)
        await OrderService.reward_invite_for_payment(
            database,
            user_id=str(order["user_id"]),
            payment_id=payment_id,
        )
        await emit_payment_succeeded(
            database,
            user_id=str(order["user_id"]),
            payment_id=payment_id,
        )
        marked = await OrderService.mark_invoice_fulfillment(
            database,
            order_id=str(order["order_id"]),
            status="completed",
            fulfillment_token=token,
        )
        if not marked:
            raise RuntimeError(
                f"Failed to mark checkout fulfillment completed: {order.get('order_id')}"
            )
    except Exception:
        await OrderService.mark_invoice_fulfillment(
            database,
            order_id=str(order["order_id"]),
            status="failed",
            fulfillment_token=token,
        )
        raise


async def _find_checkout_order(
    database: Any,
    session: dict[str, Any],
    metadata: dict[str, Any],
) -> dict | None:
    order = await OrderService.get_order_by_checkout_id(database, str(session["id"]))
    if order is not None:
        return order
    order_id = metadata.get("checkout_order_id")
    if not order_id:
        return None
    return await OrderService.get_order_by_order_id(database, order_id)


async def _payment_metadata(session: dict[str, Any], payment_intent: Any) -> dict[str, Any]:
    metadata = dict(session.get("metadata") or {})
    if isinstance(payment_intent, dict):
        return dict(payment_intent.get("metadata") or metadata)
    if isinstance(payment_intent, str) and payment_intent and get_settings().stripe_secret_key:
        intent = await retrieve_stripe_payment_intent(payment_intent)
        return dict(intent.get("metadata") or metadata)
    return metadata


def _payment_is_settled(session: dict[str, Any], payment_intent: Any) -> bool:
    if session.get("payment_status") in _SETTLED_PAYMENT_STATUSES:
        return True
    return isinstance(payment_intent, dict) and payment_intent.get("status") == "succeeded"


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
