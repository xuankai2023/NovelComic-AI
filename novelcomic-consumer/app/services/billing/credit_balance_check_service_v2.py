"""Redis pre-deduction for the three credit buckets."""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime
from typing import Any

CREDIT_BALANCE_CHECK_REDIS_KEY_PREFIX = "opencreator:credit_balance_check"
SUBSCRIPTION_USER_CREDITS_REDIS_KEY_PREFIX = "opencreator:subscription_user_credits"
GIFT_CREDITS_REDIS_KEY_PREFIX = "opencreator:gift_credits"
PENDING_DEDUCTION_REDIS_KEY_PREFIX = "opencreator:pending_deduction"

CREDIT_BALANCE_CHECK_REDIS_TTL = 7 * 24 * 60 * 60
PENDING_DEDUCTION_TTL = 24 * 60 * 60


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _is_active_until(value: Any, now: datetime) -> bool:
    if value is None:
        return True
    if isinstance(value, (int, float)):
        return int(value) > int(now.timestamp())
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    if not isinstance(value, datetime):
        return False
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value > now


class CreditBalanceCheckServiceV2:
    """Pre-deduct credits in Redis and keep a pending record for confirmation."""

    USERS = "users"
    SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
    GIFT_CREDITS = "gift_credits"

    @staticmethod
    def user_credits_key(user_id: str) -> str:
        return f"{CREDIT_BALANCE_CHECK_REDIS_KEY_PREFIX}:{user_id}"

    @staticmethod
    def subscription_credits_key(user_id: str) -> str:
        return f"{SUBSCRIPTION_USER_CREDITS_REDIS_KEY_PREFIX}:{user_id}"

    @staticmethod
    def gift_credits_key(user_id: str) -> str:
        return f"{GIFT_CREDITS_REDIS_KEY_PREFIX}:{user_id}"

    @staticmethod
    def pending_key(deduction_id: str) -> str:
        return f"{PENDING_DEDUCTION_REDIS_KEY_PREFIX}:{deduction_id}"

    @classmethod
    async def init_user_balance(cls, database: Any, redis_client: Any, user_id: str) -> None:
        redis_key = cls.user_credits_key(user_id)
        if await redis_client.exists(redis_key):
            return
        user = await database[cls.USERS].find_one({"user_id": user_id}) or {}
        await redis_client.set(
            redis_key,
            str(_safe_int(user.get("credits"))),
            ex=CREDIT_BALANCE_CHECK_REDIS_TTL,
            nx=True,
        )

    @classmethod
    async def init_subscription_user_credits(
        cls,
        database: Any,
        redis_client: Any,
        user_id: str,
    ) -> None:
        redis_key = cls.subscription_credits_key(user_id)
        if await redis_client.exists(redis_key):
            return
        now = datetime.now(UTC)
        subscription_doc = await database[cls.SUBSCRIPTION_USER_CREDITS].find_one(
            {"user_id": user_id, "status": "active"}
        )
        amount = 0
        if subscription_doc and _is_active_until(
            subscription_doc.get("expires_at") or subscription_doc.get("end_timestamp"),
            now,
        ):
            amount = _safe_int(subscription_doc.get("credits_balance"))
        await redis_client.set(
            redis_key,
            str(amount),
            ex=CREDIT_BALANCE_CHECK_REDIS_TTL,
            nx=True,
        )

    @classmethod
    async def init_gift_credits(cls, database: Any, redis_client: Any, user_id: str) -> None:
        redis_key = cls.gift_credits_key(user_id)
        if await redis_client.exists(redis_key):
            return
        now = datetime.now(UTC)
        gift_doc = await database[cls.GIFT_CREDITS].find_one({"user_id": user_id}) or {}
        amount = 0
        expires_at = gift_doc.get("expires_at") or gift_doc.get("expire_timestamp")
        if gift_doc and _is_active_until(expires_at, now):
            amount = _safe_int(gift_doc.get("amount"))
        await redis_client.set(
            redis_key,
            json.dumps({"amount": str(amount), "expires_at": str(expires_at or "")}),
            ex=CREDIT_BALANCE_CHECK_REDIS_TTL,
            nx=True,
        )

    @classmethod
    async def check_for_pre_deduction(
        cls,
        database: Any,
        redis_client: Any,
        *,
        user_id: str,
        pre_deduct_cost: int,
    ) -> tuple[bool, int, int, int, str]:
        """Deduct subscription, top-up, then gift credits in Redis only."""
        cost = _safe_int(pre_deduct_cost)
        if cost <= 0:
            return (True, 0, 0, 0, "")

        await cls.init_user_balance(database, redis_client, user_id)
        await cls.init_subscription_user_credits(database, redis_client, user_id)
        await cls.init_gift_credits(database, redis_client, user_id)

        deduction_id = uuid.uuid4().hex
        script = """
            local subscription_key = KEYS[1]
            local user_key = KEYS[2]
            local gift_key = KEYS[3]
            local pending_key = KEYS[4]
            local cost = tonumber(ARGV[1])
            local deduction_id = ARGV[2]
            local user_id = ARGV[3]
            local ts = tonumber(ARGV[4])
            local pending_ttl = tonumber(ARGV[5])

            local subscription_credits = tonumber(redis.call("GET", subscription_key) or "0")
            local user_credits = tonumber(redis.call("GET", user_key) or "0")
            local gift_raw = redis.call("GET", gift_key)
            local gift_credits = 0
            local gift_data = {amount = "0"}
            if gift_raw then
                local ok, decoded = pcall(cjson.decode, gift_raw)
                if ok and type(decoded) == "table" then
                    gift_data = decoded
                    gift_credits = tonumber(decoded["amount"] or "0") or 0
                end
            end

            if subscription_credits + user_credits + gift_credits < cost then
                return {-1, 0, 0, 0}
            end

            local remaining = cost
            local sub_deducted = math.min(subscription_credits, remaining)
            remaining = remaining - sub_deducted
            local user_deducted = math.min(user_credits, remaining)
            remaining = remaining - user_deducted
            local gift_deducted = math.min(gift_credits, remaining)

            if sub_deducted > 0 then
                redis.call("DECRBY", subscription_key, sub_deducted)
            end
            if user_deducted > 0 then
                redis.call("DECRBY", user_key, user_deducted)
            end
            if gift_deducted > 0 then
                gift_data["amount"] = tostring(gift_credits - gift_deducted)
                local ttl = redis.call("TTL", gift_key)
                redis.call("SET", gift_key, cjson.encode(gift_data))
                if ttl > 0 then
                    redis.call("EXPIRE", gift_key, ttl)
                end
            end

            redis.call(
                "SET",
                pending_key,
                cjson.encode({
                    deduction_id = deduction_id,
                    user_id = user_id,
                    cost = cost,
                    subscription = sub_deducted,
                    topup = user_deducted,
                    gift = gift_deducted,
                    ts = ts
                }),
                "EX",
                pending_ttl
            )
            return {
                subscription_credits + user_credits + gift_credits - cost,
                sub_deducted,
                user_deducted,
                gift_deducted
            }
        """
        result = await redis_client.eval(
            script,
            4,
            cls.subscription_credits_key(user_id),
            cls.user_credits_key(user_id),
            cls.gift_credits_key(user_id),
            cls.pending_key(deduction_id),
            cost,
            deduction_id,
            user_id,
            int(time.time()),
            PENDING_DEDUCTION_TTL,
        )
        if int(result[0]) < 0:
            return (False, 0, 0, 0, "")
        return (
            True,
            _safe_int(result[1]),
            _safe_int(result[2]),
            _safe_int(result[3]),
            deduction_id,
        )

    @classmethod
    async def rollback_deduct(
        cls,
        database: Any,
        redis_client: Any,
        *,
        user_id: str,
        subscription_user_credits_deducted_amount: int = 0,
        user_credits_deducted_amount: int = 0,
        gift_credits_deducted_amount: int = 0,
        deduction_id: str | None = None,
    ) -> None:
        await cls.init_user_balance(database, redis_client, user_id)
        await cls.init_subscription_user_credits(database, redis_client, user_id)
        await cls.init_gift_credits(database, redis_client, user_id)
        script = """
            local subscription_key = KEYS[1]
            local user_key = KEYS[2]
            local gift_key = KEYS[3]
            local sub_amount = tonumber(ARGV[1]) or 0
            local user_amount = tonumber(ARGV[2]) or 0
            local gift_amount = tonumber(ARGV[3]) or 0

            if sub_amount > 0 then
                redis.call("INCRBY", subscription_key, sub_amount)
            end
            if user_amount > 0 then
                redis.call("INCRBY", user_key, user_amount)
            end
            if gift_amount > 0 then
                local gift_raw = redis.call("GET", gift_key)
                local gift_data = {amount = "0"}
                local gift_credits = 0
                if gift_raw then
                    local ok, decoded = pcall(cjson.decode, gift_raw)
                    if ok and type(decoded) == "table" then
                        gift_data = decoded
                        gift_credits = tonumber(decoded["amount"] or "0") or 0
                    end
                end
                gift_data["amount"] = tostring(gift_credits + gift_amount)
                local ttl = redis.call("TTL", gift_key)
                redis.call("SET", gift_key, cjson.encode(gift_data))
                if ttl > 0 then
                    redis.call("EXPIRE", gift_key, ttl)
                end
            end
        """
        await redis_client.eval(
            script,
            3,
            cls.subscription_credits_key(user_id),
            cls.user_credits_key(user_id),
            cls.gift_credits_key(user_id),
            subscription_user_credits_deducted_amount,
            user_credits_deducted_amount,
            gift_credits_deducted_amount,
        )
        if deduction_id:
            await cls.delete_pending_deduction(redis_client, deduction_id)

    @classmethod
    async def delete_pending_deduction(cls, redis_client: Any, deduction_id: str) -> None:
        if deduction_id:
            await redis_client.delete(cls.pending_key(deduction_id))
