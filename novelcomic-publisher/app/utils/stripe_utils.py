"""Stripe webhook helpers."""

import hashlib
import hmac
import json
import time
from typing import Any

import httpx

from app.config import get_settings


class StripeSignatureError(ValueError):
    pass


def construct_stripe_event(
    body: bytes,
    signature_header: str | None,
    webhook_secret: str,
    *,
    tolerance_seconds: int = 300,
) -> dict[str, Any]:
    if not webhook_secret:
        raise StripeSignatureError("STRIPE_WEBHOOK_SECRET is not configured")
    if not signature_header:
        raise StripeSignatureError("Stripe-Signature header is missing")

    timestamp, signatures = _parse_signature_header(signature_header)
    if abs(int(time.time()) - timestamp) > tolerance_seconds:
        raise StripeSignatureError("Stripe webhook timestamp is outside tolerance")

    signed_payload = f"{timestamp}.{body.decode('utf-8')}".encode()
    expected = hmac.new(webhook_secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, signature) for signature in signatures):
        raise StripeSignatureError("Stripe webhook signature is invalid")

    try:
        event = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise StripeSignatureError("Stripe webhook payload is not valid JSON") from error
    if not isinstance(event, dict) or not event.get("id") or not event.get("type"):
        raise StripeSignatureError("Stripe webhook payload is missing id or type")
    return event


def _parse_signature_header(signature_header: str) -> tuple[int, list[str]]:
    timestamp: int | None = None
    signatures: list[str] = []
    for item in signature_header.split(","):
        key, _, value = item.partition("=")
        if key == "t" and value:
            try:
                timestamp = int(value)
            except ValueError as error:
                raise StripeSignatureError("Stripe webhook timestamp is invalid") from error
        elif key == "v1" and value:
            signatures.append(value)
    if timestamp is None or not signatures:
        raise StripeSignatureError("Stripe-Signature header is invalid")
    return timestamp, signatures


async def retrieve_stripe_checkout_session(session_id: str) -> dict[str, Any]:
    return await _stripe_get(f"/v1/checkout/sessions/{session_id}")


async def retrieve_stripe_subscription(subscription_id: str) -> dict[str, Any]:
    return await _stripe_get(f"/v1/subscriptions/{subscription_id}")


async def retrieve_stripe_payment_intent(payment_intent_id: str) -> dict[str, Any]:
    return await _stripe_get(f"/v1/payment_intents/{payment_intent_id}")


async def _stripe_get(path: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise RuntimeError("STRIPE_SECRET_KEY is not configured")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(
            f"https://api.stripe.com{path}",
            auth=(settings.stripe_secret_key, ""),
        )
    if response.status_code >= 400:
        raise RuntimeError(f"Stripe request failed: {path} status={response.status_code}")
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"Stripe request returned an unexpected payload: {path}")
    return data
