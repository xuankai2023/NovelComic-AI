"""Subscription billing outcomes that change the subscription credit pool."""

import logging
from typing import Any, Literal

from app.services.subscription_credits_reward import SubscriptionCreditsRewardService

log = logging.getLogger(__name__)

BillingReason = Literal["subscription_create", "subscription_cycle", "subscription_update"]


class SubscriptionManagementService:
    @classmethod
    async def a_process_subscription_succeed(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
        *,
        billing_reason: BillingReason,
        settlement_id: str | None = None,
        settlement_created: int | None = None,
    ) -> None:
        log.info(
            "Processing subscription succeed: stripe_subscription_id=%s billing_reason=%s",
            subscription_info.get("stripe_subscription_id"),
            billing_reason,
        )
        if billing_reason not in {
            "subscription_create",
            "subscription_cycle",
            "subscription_update",
        }:
            log.warning("Unsupported billing_reason=%s", billing_reason)
            return
        await SubscriptionCreditsRewardService.a_reward_subscription_credits(
            database,
            subscription_info,
            settlement_id=settlement_id,
            settlement_created=settlement_created,
        )

    @classmethod
    async def a_process_subscription_deleted(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
    ) -> None:
        await SubscriptionCreditsRewardService.a_deactivate_subscription_credits(
            database,
            subscription_info,
        )
