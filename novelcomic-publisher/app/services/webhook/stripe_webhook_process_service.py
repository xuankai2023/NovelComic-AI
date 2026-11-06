"""Stripe webhook dispatcher."""

import logging
from typing import Any, Protocol

from app.services.webhook.processors.stripe.ChargeRefundedProcessor import (
    ChargeRefundedProcessor,
)
from app.services.webhook.processors.stripe.CheckoutSessionAsyncPaymentFailedProcessor import (
    CheckoutSessionAsyncPaymentFailedProcessor,
)
from app.services.webhook.processors.stripe.CheckoutSessionCompletedProcessor import (
    CheckoutSessionCompletedProcessor,
)
from app.services.webhook.processors.stripe.CheckoutSessionExpiredProcessor import (
    CheckoutSessionExpiredProcessor,
)
from app.services.webhook.processors.stripe.InvoicePaymentActionRequiredProcessor import (
    InvoicePaymentActionRequiredProcessor,
)
from app.services.webhook.processors.stripe.InvoicePaymentFailedProcessor import (
    InvoicePaymentFailedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionDeletedProcessor import (
    SubscriptionDeletedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionPausedProcessor import (
    SubscriptionPausedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionSucceedProcessor import (
    SubscriptionSucceedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionUpdatedProcessor import (
    SubscriptionUpdatedProcessor,
)
from app.services.webhook.webhook_process_service_support import WebhookProcessServiceSupport

log = logging.getLogger(__name__)


class StripeWebhookProcessor(Protocol):
    @classmethod
    async def process_event(cls, database: Any, event: dict[str, Any]) -> None: ...


STRIPE_EVENT_PROCESSORS: dict[str, type[StripeWebhookProcessor]] = {
    "checkout.session.completed": CheckoutSessionCompletedProcessor,
    "checkout.session.async_payment_succeeded": CheckoutSessionCompletedProcessor,
    "checkout.session.async_payment_failed": CheckoutSessionAsyncPaymentFailedProcessor,
    "checkout.session.expired": CheckoutSessionExpiredProcessor,
    "invoice.paid": SubscriptionSucceedProcessor,
    "invoice.payment_succeeded": SubscriptionSucceedProcessor,
    "invoice.payment_failed": InvoicePaymentFailedProcessor,
    "invoice.payment_action_required": InvoicePaymentActionRequiredProcessor,
    "customer.subscription.deleted": SubscriptionDeletedProcessor,
    "customer.subscription.paused": SubscriptionPausedProcessor,
    "customer.subscription.updated": SubscriptionUpdatedProcessor,
    "charge.refunded": ChargeRefundedProcessor,
}


class StripeWebhookProcessService:
    PROVIDER = "stripe"

    @classmethod
    async def process(cls, database: Any, event: dict[str, Any]) -> dict[str, Any]:
        event_id = str(event["id"])
        event_type = str(event["type"])
        if await WebhookProcessServiceSupport.already_succeeded(
            database,
            provider=cls.PROVIDER,
            event_id=event_id,
        ):
            return {"processed": False, "duplicate": True, "event_id": event_id}

        await WebhookProcessServiceSupport.mark_processing(
            database,
            provider=cls.PROVIDER,
            event_id=event_id,
            event_type=event_type,
        )
        try:
            processor = STRIPE_EVENT_PROCESSORS.get(event_type)
            if processor is None:
                log.info("Ignoring unsupported Stripe event: %s", event_type)
            else:
                await processor.process_event(database, event)
            await WebhookProcessServiceSupport.mark_succeeded(
                database,
                provider=cls.PROVIDER,
                event_id=event_id,
            )
            return {"processed": True, "duplicate": False, "event_id": event_id}
        except Exception as error:
            await WebhookProcessServiceSupport.mark_failed(
                database,
                provider=cls.PROVIDER,
                event_id=event_id,
                error=str(error),
            )
            raise
