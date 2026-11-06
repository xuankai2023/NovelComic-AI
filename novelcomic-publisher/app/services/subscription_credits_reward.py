"""Grant and deactivate subscription credits after a paid invoice."""

import logging
from datetime import UTC, datetime
from typing import Any

from app.services.unified_credits.__base.constants.redis_keys import (
    subscription_user_credits_key,
)
from app.services.unified_credits.credits_cache import (
    SUBSCRIPTION_SETTLEMENT_LOCK_TTL_SECONDS,
    CreditsCache,
)
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService

log = logging.getLogger(__name__)


class SubscriptionCreditsRewardService:
    CREDITS = "subscription_user_credits"
    SCHEDULES = "yearly_subscription_credit_schedules"

    @classmethod
    async def a_reward_subscription_credits(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
        *,
        settlement_id: str | None = None,
        settlement_created: int | None = None,
    ) -> None:
        status = subscription_info.get("status")
        if status != "active":
            log.info(
                "Skip subscription credits for status=%s subscription_info_id=%s",
                status,
                subscription_info.get("id"),
            )
            return

        user_id = str(subscription_info["user_id"])
        lock_key = f"opencreator:subscription-credit-settlement:{user_id}"
        acquired = await CreditsCache.set_if_absent(
            lock_key,
            "1",
            SUBSCRIPTION_SETTLEMENT_LOCK_TTL_SECONDS,
        )
        if not acquired:
            raise RuntimeError("Could not acquire the subscription credit settlement lock")
        try:
            metadata = subscription_info.get("subscription_metadata") or {}
            if metadata.get("interval") == "yearly":
                await cls._start_yearly_credits(
                    database,
                    subscription_info,
                    settlement_id=settlement_id,
                    settlement_created=settlement_created,
                )
            else:
                await cls.a_reward_monthly_credits(
                    database,
                    subscription_info,
                    settlement_id=settlement_id,
                    settlement_created=settlement_created,
                )
        finally:
            await CreditsCache.delete_quietly(lock_key)

    @classmethod
    async def a_reward_monthly_credits(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
        *,
        cycle_number: int = 1,
        settlement_id: str | None = None,
        settlement_created: int | None = None,
    ) -> None:
        metadata = subscription_info.get("subscription_metadata") or {}
        credits = int(metadata.get("subscription_credits") or 0)
        if credits <= 0:
            raise RuntimeError("Subscription credits are missing")

        user_id = str(subscription_info["user_id"])
        grant_id = (
            f"stripe_invoice:{settlement_id}:cycle:{cycle_number}"
            if settlement_id
            else f"subscription:{subscription_info['id']}:cycle:{cycle_number}"
        )
        existing = await database[cls.CREDITS].find_one({"credit_grant_id": grant_id})
        if existing is not None:
            await CreditsCache.delete(subscription_user_credits_key(user_id))
            return
        if _has_newer_settlement(
            await database[cls.CREDITS].find_one({"user_id": user_id, "status": "active"}),
            settlement_created=settlement_created,
            cycle_number=cycle_number,
        ):
            log.info(
                "A newer subscription credit settlement is already active: user_id=%s",
                user_id,
            )
            return

        await UnifiedCreditsService.deactivate_subscription_credits(database, user_id=user_id)
        await UnifiedCreditsService.save_subscription_credits(
            database,
            {
                "credit_grant_id": grant_id,
                "settlement_created": settlement_created,
                "subscription_info_id": subscription_info["id"],
                "user_id": user_id,
                "stripe_subscription_id": subscription_info.get("stripe_subscription_id"),
                "cycle_number": cycle_number,
                "credits_balance": credits,
                "status": "active",
            },
        )

    @classmethod
    async def a_deactivate_subscription_credits(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
    ) -> None:
        user_id = str(subscription_info["user_id"])
        subscription_info_id = subscription_info.get("id")
        await UnifiedCreditsService.deactivate_subscription_credits(
            database,
            user_id=user_id,
            subscription_info_id=str(subscription_info_id) if subscription_info_id else None,
        )
        if subscription_info_id:
            await database["subscription_info"].update_one(
                {"id": subscription_info_id},
                {"$set": {"status": "canceled", "updated_at": datetime.now(UTC)}},
            )
        log.info(
            "Deactivated subscription credits: user_id=%s subscription_info_id=%s",
            user_id,
            subscription_info_id,
        )

    @classmethod
    async def _start_yearly_credits(
        cls,
        database: Any,
        subscription_info: dict[str, Any],
        *,
        settlement_id: str | None,
        settlement_created: int | None,
    ) -> None:
        """Grant the first month now and record the remaining monthly schedule."""
        await cls.a_reward_monthly_credits(
            database,
            subscription_info,
            cycle_number=1,
            settlement_id=settlement_id,
            settlement_created=settlement_created,
        )
        if not settlement_id:
            return
        existing = await database[cls.SCHEDULES].find_one({"credit_schedule_id": settlement_id})
        if existing is not None:
            return
        await database[cls.SCHEDULES].insert_one(
            {
                "user_id": subscription_info["user_id"],
                "subscription_info_id": subscription_info["id"],
                "credit_schedule_id": settlement_id,
                "cycle_number": 1,
                "max_cycle_number": 12,
                "credit_schedule_created": settlement_created,
                "status": "started",
                "created_at": datetime.now(UTC),
            }
        )

    @classmethod
    async def a_reward_yearly_cycle(
        cls,
        database: Any,
        *,
        credit_schedule_id: str,
        cycle_number: int,
    ) -> None:
        """Grant one monthly cycle for a yearly subscription schedule."""
        schedule = await database[cls.SCHEDULES].find_one(
            {"credit_schedule_id": credit_schedule_id}
        )
        if not schedule or schedule.get("status") == "completed":
            return
        max_cycle_number = int(schedule.get("max_cycle_number") or 12)
        cycle_number = int(cycle_number)
        if cycle_number <= int(schedule.get("cycle_number") or 0):
            return
        if cycle_number > max_cycle_number:
            return

        subscription_info = await database["subscription_info"].find_one(
            {"id": schedule["subscription_info_id"]}
        )
        if not subscription_info:
            raise RuntimeError("subscription info for yearly schedule is missing")

        await cls.a_reward_monthly_credits(
            database,
            subscription_info,
            cycle_number=cycle_number,
            settlement_id=credit_schedule_id,
            settlement_created=schedule.get("credit_schedule_created"),
        )
        await database[cls.SCHEDULES].update_one(
            {"credit_schedule_id": credit_schedule_id},
            {
                "$set": {
                    "cycle_number": cycle_number,
                    "status": "completed" if cycle_number >= max_cycle_number else "started",
                    "updated_at": datetime.now(UTC),
                }
            },
        )


def _has_newer_settlement(
    active: dict | None,
    *,
    settlement_created: int | None,
    cycle_number: int,
) -> bool:
    if active is None or settlement_created is None or active.get("settlement_created") is None:
        return False
    previous = int(active["settlement_created"])
    previous_cycle = int(active.get("cycle_number") or 1)
    return previous > int(settlement_created) or (
        previous == int(settlement_created) and previous_cycle >= cycle_number
    )
