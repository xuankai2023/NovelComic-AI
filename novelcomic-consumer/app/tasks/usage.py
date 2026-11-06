"""Usage billing instrumentation and confirmation entry points."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pymongo.errors import DuplicateKeyError

from app.services.b2b_signal.service import emit_event
from app.services.billing.credit_balance_check_service_v2 import CreditBalanceCheckServiceV2
from app.services.invocation.invocation_billing_service import calculate_cost


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


async def _get_total_balance(database: Any, user_id: str) -> tuple[int, str | None]:
    now = datetime.now(UTC)
    user_task = database["users"].find_one({"user_id": user_id})
    subscription_task = database["subscription_user_credits"].find_one(
        {"user_id": user_id, "status": "active"}
    )
    gift_task = database["gift_credits"].find_one({"user_id": user_id})
    user_doc, subscription_doc, gift_doc = await asyncio.gather(
        user_task,
        subscription_task,
        gift_task,
    )
    subscription_amount = 0
    if subscription_doc and _is_active_until(
        subscription_doc.get("expires_at") or subscription_doc.get("end_timestamp"),
        now,
    ):
        subscription_amount = _safe_int(subscription_doc.get("credits_balance"))
    gift_amount = 0
    gift_expires_at = gift_doc.get("expires_at") or gift_doc.get("expire_timestamp")
    if gift_doc and _is_active_until(gift_expires_at, now):
        gift_amount = _safe_int(gift_doc.get("amount"))
    total = _safe_int((user_doc or {}).get("credits")) + subscription_amount + gift_amount
    return total, (user_doc or {}).get("user_email")


async def _record_usage_deduct(
    database: Any,
    *,
    user_id: str,
    user_email: str | None,
    amount: int,
    balance_before: int,
    balance_after: int,
    source_id: str,
    idempotency_key: str | None,
    metadata: dict[str, Any],
) -> None:
    if amount <= 0:
        return
    now = datetime.now(UTC)
    try:
        await database["credits_inout_record"].insert_one(
            {
                "credits_inout_record_id": uuid4().hex,
                "user_id": user_id,
                "user_email": user_email,
                "credit_type": "usage",
                "event_type": "usage_deduct",
                "direction": "out",
                "amount": int(amount),
                "signed_amount": -int(amount),
                "balance_before": int(balance_before),
                "balance_after": int(balance_after),
                "reason": "Usage deducted",
                "source": "usage",
                "source_table": "usage_v2",
                "source_id": source_id,
                "idempotency_key": idempotency_key,
                "metadata": metadata,
                "created_at": now,
                "updated_at": now,
            }
        )
    except DuplicateKeyError:
        return


async def _decrement_balance_field(
    collection: Any,
    query: dict[str, Any],
    field: str,
    amount: int,
) -> None:
    if amount <= 0:
        return
    current_doc = await collection.find_one(query)
    if not current_doc:
        return
    next_value = max(0, _safe_int(current_doc.get(field)) - int(amount))
    await collection.update_one(query, {"$set": {field: next_value}})


async def emit_credits_deducted(
    database: Any,
    *,
    user_id: str,
    source_id: str,
    credits: int,
    occurred_at: datetime | None = None,
) -> None:
    await emit_event(
        database,
        user_id=user_id,
        event_type="credits_deducted",
        source_id=source_id,
        metadata={"credits": credits},
        occurred_at=occurred_at,
    )


class UsageTask:
    """Confirm a successful pre-deduction into Mongo usage and ledger records."""

    @staticmethod
    async def handle_consume(
        database: Any,
        *,
        redis_client: Any | None = None,
        invocation: dict[str, Any],
        result: dict[str, Any] | None = None,
        model_usage: dict[str, Any] | None = None,
    ) -> None:
        metadata = invocation.get("metadata") or {}
        deduction = metadata.get("deduction") or {}
        cost = _safe_int(deduction.get("deduction_cost") or (result or {}).get("cost"))
        if cost <= 0:
            return

        deduction_id = str(deduction.get("deduction_id") or "")
        if deduction_id and redis_client is None:
            # A pending Redis reservation is the source of truth for the
            # bucket split. Never settle it against Mongo while Redis is down.
            raise RuntimeError("credit service unavailable while settling usage")

        # Reconcile token-priced calls after the provider reports actual usage.
        # The initial reservation is intentionally small/non-zero; only the
        # positive delta is reserved here and merged into the same deduction.
        pricing = deduction.get("pricing")
        if deduction_id and isinstance(pricing, dict) and pricing.get("per") == "perToken":
            actual_cost = calculate_cost(
                pricing,
                {"usage": model_usage or {}},
                float(deduction.get("discount") or 1.0),
            )
            reserved_cost = _safe_int(deduction.get("deduction_cost"))
            if actual_cost > reserved_cost:
                ok, extra_sub, extra_topup, extra_gift, extra_id = await CreditBalanceCheckServiceV2.check_for_pre_deduction(
                    database,
                    redis_client,
                    user_id=str(invocation.get("user_id") or ""),
                    pre_deduct_cost=actual_cost - reserved_cost,
                )
                if not ok:
                    raise RuntimeError("insufficient credits for reported token usage")
                if extra_id:
                    await CreditBalanceCheckServiceV2.delete_pending_deduction(redis_client, extra_id)
                deduction["subscription_user_credits_deducted_amount"] = _safe_int(
                    deduction.get("subscription_user_credits_deducted_amount")
                ) + extra_sub
                deduction["user_credits_deducted_amount"] = _safe_int(
                    deduction.get("user_credits_deducted_amount")
                ) + extra_topup
                deduction["gift_credits_deducted_amount"] = _safe_int(
                    deduction.get("gift_credits_deducted_amount")
                ) + extra_gift
                deduction["deduction_cost"] = actual_cost
                cost = actual_cost
        usage_doc = {
            "_id": deduction_id or uuid4().hex,
            "user_id": invocation.get("user_id") or "",
            "model_id": invocation.get("model_id") or "",
            "model_name": invocation.get("model_id") or "",
            "cost": cost,
            "source": "consumer",
            "usage_category": "model",
            "run_id": invocation.get("run_id") or "",
            "flow_run_id": invocation.get("flow_run_id") or invocation.get("run_id") or "",
            "flow_task_id": invocation.get("flow_task_id") or "",
            "node_id": invocation.get("node_id") or "",
            "result_id": invocation.get("result_id") or "",
            "invocation_id": invocation.get("invocation_id") or invocation.get("_id") or "",
            "trace_id": invocation.get("trace_id") or "",
            "deduction_id": deduction_id or None,
            "deduction_status": "pending" if deduction_id else "deducted",
            "model_usage": model_usage or {},
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }

        if deduction_id:
            try:
                await database["usage_v2"].update_one(
                    {"deduction_id": deduction_id},
                    {"$setOnInsert": usage_doc},
                    upsert=True,
                )
            except DuplicateKeyError:
                pass
            claim = await database["usage_v2"].update_one(
                {"deduction_id": deduction_id, "deduction_status": {"$in": ["pending", "failed"]}},
                {
                    "$set": {
                        "deduction_status": "deducting",
                        "deduction_claimed_at": datetime.now(UTC),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            if getattr(claim, "matched_count", 0) == 0 and getattr(claim, "modified_count", 0) == 0:
                existing = await database["usage_v2"].find_one({"deduction_id": deduction_id})
                if existing and existing.get("deduction_status") == "deducted" and redis_client:
                    await CreditBalanceCheckServiceV2.delete_pending_deduction(
                        redis_client,
                        deduction_id,
                    )
                return
        else:
            await database["usage_v2"].insert_one(usage_doc)

        user_id = str(invocation.get("user_id") or "")
        sub_deducted = _safe_int(deduction.get("subscription_user_credits_deducted_amount"))
        topup_deducted = _safe_int(deduction.get("user_credits_deducted_amount") or cost)
        gift_deducted = _safe_int(deduction.get("gift_credits_deducted_amount"))
        balance_before, user_email = await _get_total_balance(database, user_id)

        update_tasks = []
        if sub_deducted > 0:
            update_tasks.append(
                _decrement_balance_field(
                    database["subscription_user_credits"],
                    {"user_id": user_id, "status": "active"},
                    "credits_balance",
                    sub_deducted,
                )
            )
        if topup_deducted > 0:
            update_tasks.append(
                _decrement_balance_field(
                    database["users"],
                    {"user_id": user_id},
                    "credits",
                    topup_deducted,
                )
            )
        if gift_deducted > 0:
            update_tasks.append(
                _decrement_balance_field(
                    database["gift_credits"],
                    {"user_id": user_id},
                    "amount",
                    gift_deducted,
                )
            )
        if update_tasks:
            await asyncio.gather(*update_tasks)

        balance_after, refreshed_email = await _get_total_balance(database, user_id)
        await _record_usage_deduct(
            database,
            user_id=user_id,
            user_email=user_email or refreshed_email,
            amount=cost,
            balance_before=balance_before,
            balance_after=balance_after,
            source_id=deduction_id or str(usage_doc["_id"]),
            idempotency_key=f"usage_deduct:{deduction_id}" if deduction_id else None,
            metadata={
                "cost": cost,
                "deduction_metadata": deduction,
                "run_id": invocation.get("run_id"),
                "node_id": invocation.get("node_id"),
                "result_id": invocation.get("result_id"),
            },
        )

        if deduction_id:
            if redis_client:
                await CreditBalanceCheckServiceV2.delete_pending_deduction(
                    redis_client,
                    deduction_id,
                )
            await database["usage_v2"].update_one(
                {"deduction_id": deduction_id},
                {
                    "$set": {
                        "deduction_status": "deducted",
                        "deducted_at": datetime.now(UTC),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
        await database["model_invocations"].update_one(
            {"_id": invocation.get("_id")},
            {
                "$set": {
                    "usage_status": "confirmed",
                    "usage_confirmed_at": datetime.now(UTC),
                    "updated_at": datetime.now(UTC),
                }
            },
        )
        await emit_credits_deducted(
            database,
            user_id=user_id,
            source_id=deduction_id or str(usage_doc["_id"]),
            credits=cost,
        )
