"""Grant subscription credits after a paid Stripe invoice."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.b2b_signal.instrumentation import emit_payment_succeeded
from app.services.order import OrderService
from app.services.subscription_info import SubscriptionInfoService
from app.services.subscription_management import BillingReason, SubscriptionManagementService
from app.utils.stripe_utils import retrieve_stripe_subscription

log = logging.getLogger(__name__)

_SUPPORTED_REASONS = {"subscription_create", "subscription_cycle", "subscription_update"}


class SubscriptionSucceedProcessor:
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None:
        invoice = _event_object(event)
        invoice_id = invoice.get("id")
        if not invoice_id:
            log.info("Stripe invoice success has no invoice: event_id=%s", event.get("id"))
            return

        stripe_subscription, subscription_id = await _load_subscription(invoice)
        if stripe_subscription is None or not subscription_id:
            log.warning("Paid invoice has no subscription: invoice_id=%s", invoice_id)
            return

        billing_reason = str(invoice.get("billing_reason") or "")
        if billing_reason not in _SUPPORTED_REASONS:
            log.warning("Unsupported billing_reason=%s invoice_id=%s", billing_reason, invoice_id)
            return

        if billing_reason == "subscription_create":
            await cls._fulfill_creation(database, invoice, stripe_subscription, subscription_id)
            return
        await cls._fulfill_modification(
            database,
            invoice,
            stripe_subscription,
            subscription_id,
            billing_reason,  # type: ignore[arg-type]
        )

    @classmethod
    async def process(
        cls,
        database: Any,
        *,
        user_id: str,
        subscription_id: str,
        paid_at: datetime | None = None,
    ) -> None:
        await OrderService.reward_invite_for_payment(
            database,
            user_id=user_id,
            payment_id=subscription_id,
            paid_at=paid_at,
        )
        await emit_payment_succeeded(
            database,
            user_id=user_id,
            payment_id=subscription_id,
            paid_at=paid_at,
        )

    @classmethod
    async def _fulfill_creation(
        cls,
        database: Any,
        invoice: dict[str, Any],
        stripe_subscription: dict[str, Any],
        subscription_id: str,
    ) -> None:
        metadata = stripe_subscription.get("metadata") or {}
        checkout_order_id = str(metadata.get("checkout_order_id") or "")
        order = (
            await OrderService.get_order_by_order_id(database, checkout_order_id)
            if checkout_order_id
            else None
        )
        if order is None:
            user_id = str(metadata.get("user_id") or "")
            if not user_id:
                raise RuntimeError(f"Paid subscription invoice {invoice.get('id')} has no user ID")
            order = await OrderService.insert_order(
                database,
                {
                    "user_id": user_id,
                    "type": "recurring",
                    "pay_mode": "subscription",
                    "stripe_order_id": subscription_id,
                    "stripe_invoice_id": str(invoice["id"]),
                    "amount": int(invoice.get("amount_paid") or 0),
                    "currency": str(invoice.get("currency") or "usd"),
                },
            )
        await cls._grant(database, invoice, order, stripe_subscription, "subscription_create")

    @classmethod
    async def _fulfill_modification(
        cls,
        database: Any,
        invoice: dict[str, Any],
        stripe_subscription: dict[str, Any],
        subscription_id: str,
        billing_reason: BillingReason,
    ) -> None:
        existing = await SubscriptionInfoService.get_by_stripe_subscription_id(
            database,
            subscription_id,
        )
        if existing is None:
            log.info(
                "No local subscription for %s; fulfilling the paid invoice as creation",
                subscription_id,
            )
            await cls._fulfill_creation(database, invoice, stripe_subscription, subscription_id)
            return

        invoice_id = str(invoice["id"])
        order = await OrderService.get_order_by_stripe_invoice_id(database, invoice_id)
        if order is None:
            order = await OrderService.insert_order(
                database,
                {
                    "user_id": existing["user_id"],
                    "type": "recurring",
                    "pay_mode": "subscription",
                    "stripe_order_id": subscription_id,
                    "stripe_invoice_id": invoice_id,
                    "amount": int(invoice.get("amount_paid") or 0),
                    "currency": str(invoice.get("currency") or "usd"),
                    "pay_result": "succeeded",
                    "pay_status": "paid",
                },
            )
        await cls._grant(database, invoice, order, stripe_subscription, billing_reason)

    @classmethod
    async def _grant(
        cls,
        database: Any,
        invoice: dict[str, Any],
        order: dict[str, Any],
        stripe_subscription: dict[str, Any],
        billing_reason: BillingReason,
    ) -> None:
        invoice_id = str(invoice["id"])
        order = await OrderService.attach_paid_invoice(
            database,
            order,
            stripe_invoice_id=invoice_id,
            stripe_subscription_id=str(stripe_subscription.get("id") or ""),
            amount=int(invoice.get("amount_paid") or 0),
            currency=str(invoice.get("currency") or order.get("currency") or "usd"),
        )
        prepared = SubscriptionInfoService.prepare_from_paid_subscription(
            order=order,
            stripe_subscription=stripe_subscription,
            invoice_id=invoice_id,
        )
        saved = await SubscriptionInfoService.upsert(database, prepared)
        if saved.get("status") != "active":
            log.info(
                "Paid invoice left the subscription inactive: invoice_id=%s status=%s",
                invoice_id,
                saved.get("status"),
            )
            return

        claimed = await OrderService.claim_invoice_fulfillment(database, str(order["order_id"]))
        if claimed is None:
            current = await OrderService.get_order_by_order_id(database, str(order["order_id"]))
            log.info(
                "Invoice fulfillment was not claimed: invoice_id=%s fulfillment_status=%s",
                invoice_id,
                (current or {}).get("fulfillment_status"),
            )
            return
        token = str(claimed.get("fulfillment_token") or "")
        if not token:
            raise RuntimeError(f"Invoice {invoice_id} fulfillment claim has no fencing token")

        created = invoice.get("created")
        paid_at = datetime.fromtimestamp(int(created), UTC) if created else None
        settlement_created = int(created) if created is not None else None
        try:
            await SubscriptionManagementService.a_process_subscription_succeed(
                database,
                saved,
                billing_reason=billing_reason,
                settlement_id=invoice_id,
                settlement_created=settlement_created,
            )
            await cls.process(
                database,
                user_id=str(saved["user_id"]),
                subscription_id=str(saved.get("stripe_subscription_id") or invoice_id),
                paid_at=paid_at,
            )
            marked = await OrderService.mark_invoice_fulfillment(
                database,
                order_id=str(order["order_id"]),
                status="completed",
                fulfillment_token=token,
            )
            if not marked:
                raise RuntimeError(f"Failed to mark invoice fulfillment completed: {invoice_id}")
        except Exception:
            await OrderService.mark_invoice_fulfillment(
                database,
                order_id=str(order["order_id"]),
                status="failed",
                fulfillment_token=token,
            )
            raise


async def _load_subscription(
    invoice: dict[str, Any],
) -> tuple[dict[str, Any] | None, str]:
    subscription = invoice.get("subscription")
    if isinstance(subscription, dict):
        return subscription, str(subscription.get("id") or "")
    subscription_id = str(subscription or "")
    if not subscription_id:
        return None, ""
    return await retrieve_stripe_subscription(subscription_id), subscription_id


def _event_object(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data") or {}
    obj = data.get("object") if isinstance(data, dict) else None
    return obj if isinstance(obj, dict) else {}
