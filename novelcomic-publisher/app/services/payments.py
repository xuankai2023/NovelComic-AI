"""Checkout creation, subscription plan management, invoice/portal, and local payment order persistence."""

import hashlib
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import httpx

from app.config import Settings
from app.schemas.payments import (
    CheckoutSessionResponse,
    CreateCheckoutRequestParam,
    CreateSubscriptionCheckoutRequestParam,
    Order,
    UpdateSubscriptionPlanRequestParam,
)
from app.services.user import UserService

log = logging.getLogger(__name__)


class PaymentCheckoutError(RuntimeError):
    pass


class SubscriptionCheckoutConflictError(RuntimeError):
    pass


SUBSCRIPTION_TEMPLATE_PLANS: dict[str, dict[str, Any]] = {
    "starter": {
        "key": "starter",
        "name": "Starter",
        "level": 1,
        "monthly_price_cents": 1900,
        "yearly_price_cents": 18000,
        "monthly_credits": 800,
        "yearly_credits": 9600,
        "monthly_price_id": "price_starter_monthly",
        "yearly_price_id": "price_starter_yearly",
        "features": ["800 credits / month", "Standard generation queue", "Commercial license"],
    },
    "creator": {
        "key": "creator",
        "name": "Creator",
        "level": 2,
        "monthly_price_cents": 4900,
        "yearly_price_cents": 46800,
        "monthly_credits": 2400,
        "yearly_credits": 28800,
        "monthly_price_id": "price_creator_monthly",
        "yearly_price_id": "price_creator_yearly",
        "features": ["2,400 credits / month", "Priority generation queue", "All AI models"],
    },
    "pro": {
        "key": "pro",
        "name": "Pro",
        "level": 3,
        "monthly_price_cents": 9900,
        "yearly_price_cents": 94800,
        "monthly_credits": 6000,
        "yearly_credits": 72000,
        "monthly_price_id": "price_pro_monthly",
        "yearly_price_id": "price_pro_yearly",
        "features": ["6,000 credits / month", "500 credits/$ top-up bonus", "Dedicated concurrency"],
    },
}


class PaymentsService:
    ORDERS = "orders"
    SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
    SUBSCRIPTION_INFO = "subscription_info"

    @classmethod
    def get_subscription_template(cls) -> dict[str, Any]:
        return {"plans": list(SUBSCRIPTION_TEMPLATE_PLANS.values())}

    @classmethod
    def get_stripe_plan_config(cls) -> dict[str, Any]:
        return {
            key: {
                "level": plan["level"],
                "monthly": {
                    "price_id": plan["monthly_price_id"],
                    "amount_cents": plan["monthly_price_cents"],
                    "credits": plan["monthly_credits"],
                },
                "yearly": {
                    "price_id": plan["yearly_price_id"],
                    "amount_cents": plan["yearly_price_cents"],
                    "credits": plan["yearly_credits"],
                },
            }
            for key, plan in SUBSCRIPTION_TEMPLATE_PLANS.items()
        }

    @classmethod
    async def create_checkout_session(
        cls,
        database: Any,
        settings: Settings,
        *,
        param: CreateCheckoutRequestParam,
        user_id: str,
    ) -> CheckoutSessionResponse:
        user = await cls._require_user(database, user_id)
        request_id = param.request_id or uuid4().hex
        amount = int(param.amount * 100)
        order = Order(
            user_id=user_id,
            checkout_request_id=request_id,
            amount=amount,
            type="one_time",
            pay_mode="payment",
            pay_method=param.payment_method,
        )
        payload: dict[str, str] = {
            "mode": "payment",
            "success_url": param.success_url,
            "cancel_url": param.cancel_url,
            "customer_email": user.get("user_email") or "",
            "allow_promotion_codes": "true",
            "line_items[0][price_data][currency]": order.currency,
            "line_items[0][price_data][product_data][name]": "NovelComic Credits",
            "line_items[0][price_data][unit_amount]": str(amount),
            "line_items[0][quantity]": "1",
            "metadata[user_id]": user_id,
            "metadata[checkout_type]": "credits",
            "metadata[checkout_order_id]": order.order_id,
            "metadata[checkout_request_id]": request_id,
            "invoice_creation[enabled]": "true",
            "payment_method_types[0]": "card",
            "payment_method_types[1]": "alipay",
            "payment_method_types[2]": "wechat_pay",
            "payment_method_options[wechat_pay][client]": "web",
        }
        stripe_session = await cls._create_stripe_checkout_session(
            settings,
            idempotency_key=cls._stripe_idempotency_key(user_id, request_id),
            payload=payload,
        )
        return await cls._save_order_from_session(database, order, stripe_session)

    @classmethod
    async def create_subscription_checkout_session(
        cls,
        database: Any,
        settings: Settings,
        *,
        param: CreateSubscriptionCheckoutRequestParam,
        user_id: str,
        allow_existing_subscription: bool = False,
    ) -> CheckoutSessionResponse:
        user = await cls._require_user(database, user_id)
        await cls._ensure_subscription_checkout_allowed(
            database,
            user_id,
            allow_existing_subscription=allow_existing_subscription,
        )
        request_id = param.request_id or uuid4().hex
        plan = SUBSCRIPTION_TEMPLATE_PLANS.get(param.subscription_key) or SUBSCRIPTION_TEMPLATE_PLANS["starter"]
        base_monthly_credits = int(plan["monthly_credits"])
        level = int(plan["level"])

        is_china_one_time = param.payment_method in {"china", "wechat_pay", "alipay"} and (
            param.subscription_key in SUBSCRIPTION_TEMPLATE_PLANS
        )

        if is_china_one_time:
            total_credits = (
                base_monthly_credits * 12 if param.interval == "yearly" else base_monthly_credits
            )
            amount_cents = (
                int(plan["yearly_price_cents"])
                if param.interval == "yearly"
                else int(plan["monthly_price_cents"])
            )
            order = Order(
                user_id=user_id,
                checkout_request_id=request_id,
                amount=amount_cents,
                type="one_time",
                pay_mode="payment",
                pay_method=param.payment_method,
            )
            payload: dict[str, str] = {
                "mode": "payment",
                "success_url": param.success_url,
                "cancel_url": param.cancel_url,
                "customer_email": user.get("user_email") or "",
                "allow_promotion_codes": "true",
                "line_items[0][price]": param.price_id,
                "line_items[0][quantity]": "1",
                "metadata[user_id]": user_id,
                "metadata[checkout_type]": "subscription",
                "metadata[is_subscription_purchase]": "true",
                "metadata[payment_method]": str(param.payment_method),
                "metadata[subscription_key]": param.subscription_key,
                "metadata[interval]": param.interval,
                "metadata[price_id]": param.price_id,
                "metadata[subscription_credits]": str(total_credits),
                "metadata[level]": str(level),
                "metadata[checkout_order_id]": order.order_id,
                "metadata[checkout_request_id]": request_id,
                "payment_method_types[0]": "card",
                "payment_method_types[1]": "alipay",
                "payment_method_types[2]": "wechat_pay",
                "payment_method_options[wechat_pay][client]": "web",
            }
            stripe_session = await cls._create_stripe_checkout_session(
                settings,
                idempotency_key=cls._stripe_idempotency_key(user_id, request_id),
                payload=payload,
            )
            return await cls._save_order_from_session(database, order, stripe_session)

        order = Order(
            user_id=user_id,
            checkout_request_id=request_id,
            type="recurring",
            pay_mode="subscription",
            pay_method=param.payment_method,
        )
        stripe_session = await cls._create_stripe_checkout_session(
            settings,
            idempotency_key=cls._stripe_idempotency_key(user_id, request_id),
            payload={
                "mode": "subscription",
                "success_url": param.success_url,
                "cancel_url": param.cancel_url,
                "customer_email": user.get("user_email") or "",
                "allow_promotion_codes": "true",
                "line_items[0][price]": param.price_id,
                "line_items[0][quantity]": "1",
                "metadata[user_id]": user_id,
                "metadata[checkout_type]": "subscription",
                "metadata[checkout_order_id]": order.order_id,
                "metadata[checkout_request_id]": request_id,
                "subscription_data[metadata][user_id]": user_id,
                "subscription_data[metadata][subscription_key]": param.subscription_key,
                "subscription_data[metadata][interval]": param.interval,
                "subscription_data[metadata][price_id]": param.price_id,
                "subscription_data[metadata][subscription_credits]": str(base_monthly_credits),
                "subscription_data[metadata][level]": str(level),
                "subscription_data[metadata][checkout_order_id]": order.order_id,
            },
        )
        return await cls._save_order_from_session(database, order, stripe_session)

    @classmethod
    async def update_subscription_plan(
        cls,
        database: Any,
        settings: Settings,
        *,
        param: UpdateSubscriptionPlanRequestParam,
        user_id: str,
    ) -> dict[str, Any]:
        existing_info = await database[cls.SUBSCRIPTION_INFO].find_one(
            {"id": param.subscription_info_id, "user_id": user_id}
        )
        if existing_info and existing_info.get("stripe_subscription_id"):
            return await cls._update_existing_subscription(
                database,
                settings,
                existing_info=dict(existing_info),
                param=param,
                user_id=user_id,
            )

        checkout = await cls.create_subscription_checkout_session(
            database,
            settings,
            param=CreateSubscriptionCheckoutRequestParam(
                successUrl=param.success_url,
                cancelUrl=param.cancel_url,
                request_id=param.request_id,
                subscription_key=param.subscription_key,
                interval=param.interval,
                price_id=param.price_id,
                payment_method=param.payment_method,
            ),
            user_id=user_id,
            allow_existing_subscription=True,
        )
        return checkout.model_dump(mode="json")

    @classmethod
    async def _update_existing_subscription(
        cls,
        database: Any,
        settings: Settings,
        *,
        existing_info: dict[str, Any],
        param: UpdateSubscriptionPlanRequestParam,
        user_id: str,
    ) -> dict[str, Any]:
        current_meta = existing_info.get("subscription_metadata") or {}
        if (
            current_meta.get("subscription_key") == param.subscription_key
            and current_meta.get("interval") == param.interval
            and param.price_id in (existing_info.get("price_ids") or [])
        ):
            return {}

        plan = SUBSCRIPTION_TEMPLATE_PLANS.get(param.subscription_key) or SUBSCRIPTION_TEMPLATE_PLANS["starter"]
        target_level = int(plan["level"])
        current_level = int(current_meta.get("level") or 1)
        stripe_sub_id = str(existing_info["stripe_subscription_id"])

        stripe_result = await cls._modify_stripe_subscription(
            settings,
            stripe_subscription_id=stripe_sub_id,
            price_id=param.price_id,
            subscription_key=param.subscription_key,
            interval=param.interval,
            subscription_credits=int(plan["monthly_credits"]),
            level=target_level,
            is_upgrade=target_level >= current_level,
        )

        if stripe_result.get("requires_action"):
            await database[cls.SUBSCRIPTION_INFO].update_one(
                {"id": existing_info["id"]},
                {"$set": {"status": "3ds_processing", "updated_at": datetime.now(UTC)}},
            )
            return {
                "url": None,
                "requires_action": True,
                "client_secret": stripe_result.get("client_secret"),
            }

        if target_level < current_level:
            await database[cls.SUBSCRIPTION_INFO].update_one(
                {"id": existing_info["id"]},
                {
                    "$set": {
                        "pending_downgrade_key": param.subscription_key,
                        "pending_downgrade_price_id": param.price_id,
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            return {
                "url": None,
                "deferred_action": "downgrade_at_period_end",
                "subscription_info_id": existing_info["id"],
            }

        await database[cls.SUBSCRIPTION_INFO].update_one(
            {"id": existing_info["id"]},
            {
                "$set": {
                    "status": str(stripe_result.get("status") or "upgrading"),
                    "updated_at": datetime.now(UTC),
                }
            },
        )
        return {
            "url": None,
            "requires_action": False,
            "subscription_info_id": existing_info["id"],
            "status": str(stripe_result.get("status") or "upgrading"),
        }

    @staticmethod
    async def _modify_stripe_subscription(
        settings: Settings,
        *,
        stripe_subscription_id: str,
        price_id: str,
        subscription_key: str,
        interval: str,
        subscription_credits: int,
        level: int,
        is_upgrade: bool,
    ) -> dict[str, Any]:
        if not settings.stripe_secret_key:
            return {"status": "upgrading" if is_upgrade else "active", "requires_action": False}
        payload = {
            "proration_behavior": "always_invoice" if is_upgrade else "none",
            "metadata[subscription_key]": subscription_key,
            "metadata[interval]": interval,
            "metadata[price_id]": price_id,
            "metadata[subscription_credits]": str(subscription_credits),
            "metadata[level]": str(level),
            "expand[0]": "latest_invoice.payment_intent",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                f"https://api.stripe.com/v1/subscriptions/{stripe_subscription_id}",
                data=payload,
                auth=(settings.stripe_secret_key, ""),
            )
        if response.status_code >= 400:
            raise PaymentCheckoutError("Failed to update Stripe subscription")
        data = response.json()
        latest_invoice = data.get("latest_invoice")
        payment_intent = (
            latest_invoice.get("payment_intent") if isinstance(latest_invoice, dict) else None
        )
        if (
            isinstance(payment_intent, dict)
            and payment_intent.get("status") == "requires_action"
        ):
            return {
                "status": "3ds_processing",
                "requires_action": True,
                "client_secret": payment_intent.get("client_secret"),
            }
        return {
            "status": data.get("status") or "active",
            "requires_action": False,
        }

    @classmethod
    async def get_checkout_session_status(
        cls,
        database: Any,
        settings: Settings,
        *,
        session_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        order = await database[cls.ORDERS].find_one(
            {"checkout_id": session_id, "user_id": user_id}
        )
        stripe_data: dict[str, Any] = {}
        if settings.stripe_secret_key:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(
                        f"https://api.stripe.com/v1/checkout/sessions/{session_id}",
                        auth=(settings.stripe_secret_key, ""),
                    )
                if resp.status_code < 400:
                    stripe_data = resp.json()
            except Exception as exc:
                log.warning("Failed to fetch Stripe checkout session %s: %s", session_id, exc)

        return {
            "session_id": session_id,
            "status": stripe_data.get("status") or (order.get("pay_result") if order else None),
            "payment_status": stripe_data.get("payment_status")
            or (order.get("pay_status") if order else None),
            "mode": stripe_data.get("mode") or (order.get("pay_mode") if order else None),
            "order_id": order.get("order_id") if order else None,
            "pay_result": order.get("pay_result") if order else None,
        }

    @classmethod
    async def get_invoice_info(
        cls,
        database: Any,
        settings: Settings,
        *,
        user_id: str,
        session_id: str | None = None,
        subscription_id: str | None = None,
    ) -> dict[str, Any]:
        invoice_id: str | None = None
        if session_id:
            order = await database[cls.ORDERS].find_one(
                {"checkout_id": session_id, "user_id": user_id}
            )
            if order and order.get("stripe_invoice_id"):
                invoice_id = str(order["stripe_invoice_id"])
        elif subscription_id:
            sub = await database[cls.SUBSCRIPTION_INFO].find_one(
                {"stripe_subscription_id": subscription_id, "user_id": user_id}
            )
            if sub and sub.get("last_paid_invoice_id"):
                invoice_id = str(sub["last_paid_invoice_id"])

        if invoice_id and settings.stripe_secret_key:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(
                        f"https://api.stripe.com/v1/invoices/{invoice_id}",
                        auth=(settings.stripe_secret_key, ""),
                    )
                if resp.status_code < 400:
                    inv = resp.json()
                    return {
                        "invoice_id": inv.get("id") or invoice_id,
                        "hosted_invoice_url": inv.get("hosted_invoice_url"),
                        "invoice_pdf": inv.get("invoice_pdf"),
                        "status": inv.get("status"),
                    }
            except Exception as exc:
                log.warning("Failed to fetch Stripe invoice %s: %s", invoice_id, exc)

        return {
            "invoice_id": invoice_id,
            "hosted_invoice_url": f"https://invoice.stripe.com/i/{invoice_id}" if invoice_id else None,
            "invoice_pdf": None,
            "status": "paid" if invoice_id else None,
        }

    @classmethod
    async def create_billing_portal_session(
        cls,
        database: Any,
        settings: Settings,
        *,
        user_id: str,
        return_url: str,
    ) -> dict[str, Any]:
        user = await cls._require_user(database, user_id)
        customer_id = user.get("stripe_customer_id")
        if settings.stripe_secret_key and customer_id:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://api.stripe.com/v1/billing_portal/sessions",
                    data={"customer": str(customer_id), "return_url": return_url},
                    auth=(settings.stripe_secret_key, ""),
                )
            if resp.status_code < 400:
                data = resp.json()
                return {"url": data.get("url")}
        return {"url": return_url or "https://billing.stripe.com/p/login/default"}

    @classmethod
    async def ensure_indexes(cls, database: Any) -> None:
        await _maybe_create_index(database[cls.ORDERS], [("order_id", 1)], unique=True)
        await _maybe_create_index(database[cls.ORDERS], [("checkout_id", 1)], sparse=True)
        await _maybe_create_index(
            database[cls.ORDERS],
            [("user_id", 1), ("pay_mode", 1), ("pay_result", 1)],
        )

    @classmethod
    async def _require_user(cls, database: Any, user_id: str) -> dict:
        user = await UserService.get_user_by_id(database, user_id)
        if user is None:
            raise PaymentCheckoutError(f"User not found: {user_id}")
        return user

    @classmethod
    async def _ensure_subscription_checkout_allowed(
        cls,
        database: Any,
        user_id: str,
        *,
        allow_existing_subscription: bool,
    ) -> None:
        existing_checkout = await database[cls.ORDERS].find_one(
            {"user_id": user_id, "pay_mode": "subscription", "pay_result": "processing"}
        )
        if existing_checkout:
            raise SubscriptionCheckoutConflictError(
                "A subscription checkout is already in progress"
            )

        if allow_existing_subscription:
            return
        active_subscription = await database[cls.SUBSCRIPTION_USER_CREDITS].find_one(
            {"user_id": user_id, "status": "active"}
        )
        if active_subscription:
            raise SubscriptionCheckoutConflictError(
                "An active subscription must be resolved before starting checkout"
            )

    @classmethod
    async def _save_order_from_session(
        cls,
        database: Any,
        order: Order,
        stripe_session: dict[str, Any],
    ) -> CheckoutSessionResponse:
        session_id = str(stripe_session["id"])
        session_url = str(stripe_session["url"])
        order.checkout_id = session_id
        order.checkout_url = session_url
        order.pay_result = "processing"
        order.updated_at = datetime.now(UTC)
        await database[cls.ORDERS].insert_one(order.model_dump(mode="json"))
        return CheckoutSessionResponse(
            id=session_id,
            url=session_url,
            mode=order.pay_mode,
            status=stripe_session.get("status"),
            order_id=order.order_id,
        )

    @staticmethod
    def _stripe_idempotency_key(user_id: str, request_id: str) -> str:
        digest = hashlib.sha256(f"{user_id}:{request_id}".encode()).hexdigest()
        return f"oc_checkout_{digest}"

    @staticmethod
    async def _create_stripe_checkout_session(
        settings: Settings,
        *,
        idempotency_key: str,
        payload: dict[str, str],
    ) -> dict[str, Any]:
        if not settings.stripe_secret_key:
            raise PaymentCheckoutError("STRIPE_SECRET_KEY is not configured")
        clean_payload = {key: value for key, value in payload.items() if value}
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.stripe.com/v1/checkout/sessions",
                data=clean_payload,
                headers={"Idempotency-Key": idempotency_key},
                auth=(settings.stripe_secret_key, ""),
            )
        if response.status_code >= 400:
            log.warning(
                "Stripe checkout failed: status=%s body=%s",
                response.status_code,
                response.text,
            )
            raise PaymentCheckoutError("Failed to create Stripe Checkout Session")
        data = response.json()
        if not data.get("id") or not data.get("url"):
            raise PaymentCheckoutError("Stripe Checkout Session response is missing id or url")
        return data


async def _maybe_create_index(collection: Any, keys: list[tuple[str, int]], **kwargs: Any) -> None:
    create_index = getattr(collection, "create_index", None)
    if create_index is None:
        return
    await create_index(keys, **kwargs)
