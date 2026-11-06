"""Billing hooks for model invocation submission and callbacks."""

from __future__ import annotations

import math
from typing import Any

from app.services.billing.credit_balance_check_service_v2 import CreditBalanceCheckServiceV2


class InsufficientCreditsError(RuntimeError):
    """Raised when Redis pre-deduction cannot reserve enough credits."""


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def calculate_cost(
    pricing: Any,
    arguments: dict[str, Any] | None = None,
    discount: float = 1.0,
) -> int:
    """Calculate integer credit cost from the node pricing shape used by the catalog."""
    if pricing is None:
        return 0
    if isinstance(pricing, (int, float, str)):
        base = float(pricing or 0)
    elif isinstance(pricing, dict):
        if pricing.get("per") == "perToken":
            usage = (arguments or {}).get("usage") or {}
            prompt = _safe_int(usage.get("prompt_tokens") or usage.get("input_tokens"))
            completion = _safe_int(usage.get("completion_tokens") or usage.get("output_tokens"))
            input_rate = float(pricing.get("input_credits_per_token") or pricing.get("input") or 0)
            output_rate = float(
                pricing.get("output_credits_per_token") or pricing.get("output") or 0
            )
            base = prompt * input_rate + completion * output_rate
        else:
            base = float(
                pricing.get("credits")
                or pricing.get("cost")
                or pricing.get("amount")
                or pricing.get("credit_cost")
                or 0
            )
    else:
        return 0
    return max(0, int(math.ceil(base * max(0.0, float(discount or 0)))))


class InvocationBillingService:
    @staticmethod
    def _node_config(node: dict[str, Any]) -> dict[str, Any]:
        node_data = node.get("node_data") or {}
        data = node_data.get("data") if isinstance(node_data.get("data"), dict) else {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _pricing(node: dict[str, Any]) -> Any:
        node_config = InvocationBillingService._node_config(node)
        return node_config.get("pricing") or node_config.get("billing") or node.get("pricing")

    @classmethod
    async def _subscription_discount(
        cls,
        database: Any,
        *,
        user_id: str,
        model_id: str,
    ) -> float:
        del model_id
        doc = await database["subscription_user_credits"].find_one(
            {"user_id": user_id, "status": "active"}
        )
        if not doc:
            return 1.0
        raw = doc.get("model_discount") or doc.get("discount") or doc.get("model_off")
        if raw is None:
            return 1.0
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return 1.0
        if value > 1:
            value = value / 100
        return min(1.0, max(0.0, value))

    @classmethod
    async def reserve_for_node(
        cls,
        database: Any,
        redis_client: Any | None,
        *,
        user_id: str,
        model_id: str,
        node: dict[str, Any],
        arguments: dict[str, Any],
    ) -> dict[str, Any] | None:
        discount = await cls._subscription_discount(
            database,
            user_id=user_id,
            model_id=model_id,
        )
        cost = calculate_cost(cls._pricing(node), arguments, discount)
        pricing = cls._pricing(node)
        # Token-priced models do not know their final usage at submit time. Keep
        # a non-zero reservation so a missing usage callback can never become a
        # free invocation; the callback settles the delta once usage is known.
        if cost <= 0 and isinstance(pricing, dict) and pricing.get("per") == "perToken":
            cost = max(1, _safe_int(pricing.get("minimum_credits") or pricing.get("minimum_cost")))
        if cost <= 0:
            return None
        if redis_client is None:
            raise InsufficientCreditsError("credit service unavailable")

        (
            ok,
            subscription_deducted,
            topup_deducted,
            gift_deducted,
            deduction_id,
        ) = await CreditBalanceCheckServiceV2.check_for_pre_deduction(
            database,
            redis_client,
            user_id=user_id,
            pre_deduct_cost=cost,
        )
        if not ok:
            raise InsufficientCreditsError("insufficient credits")
        return {
            "deduction_id": deduction_id,
            "deduction_cost": cost,
            "subscription_user_credits_deducted_amount": subscription_deducted,
            "user_credits_deducted_amount": topup_deducted,
            "gift_credits_deducted_amount": gift_deducted,
            "model_id": model_id,
            "pricing": pricing,
            "discount": discount,
        }

    @classmethod
    async def rollback_deduction(
        cls,
        database: Any,
        redis_client: Any | None,
        *,
        user_id: str,
        deduction: dict[str, Any] | None,
    ) -> None:
        if redis_client is None or not deduction:
            return
        await CreditBalanceCheckServiceV2.rollback_deduct(
            database,
            redis_client,
            user_id=user_id,
            subscription_user_credits_deducted_amount=_safe_int(
                deduction.get("subscription_user_credits_deducted_amount")
            ),
            user_credits_deducted_amount=_safe_int(
                deduction.get("user_credits_deducted_amount")
            ),
            gift_credits_deducted_amount=_safe_int(
                deduction.get("gift_credits_deducted_amount")
            ),
            deduction_id=deduction.get("deduction_id"),
        )
