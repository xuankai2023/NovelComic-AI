"""Step 5 and 6: settled top-ups and paid subscription invoices grant credits once."""

import base64
import copy
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pymongo import ReturnDocument

from app.config import get_settings
from app.main import create_app
from app.services.gift_credits import GiftCreditsService
from app.services.payments import PaymentsService
from app.services.subscription_credits_reward import SubscriptionCreditsRewardService
from app.services.unified_credits.__base.constants.redis_keys import (
    credit_balance_check_key,
    credits_idempotency_key,
)
from app.services.unified_credits.credits_cache import CreditsCache
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService
from app.services.webhook.processors.stripe import (
    CheckoutSessionCompletedProcessor as checkout_module,
)
from app.services.webhook.processors.stripe.CheckoutSessionCompletedProcessor import (
    CheckoutSessionCompletedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionDeletedProcessor import (
    SubscriptionDeletedProcessor,
)
from app.services.webhook.processors.stripe.SubscriptionSucceedProcessor import (
    SubscriptionSucceedProcessor,
)
from app.services.webhook.stripe_webhook_process_service import StripeWebhookProcessService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"novelcomic-fulfillment-secret").decode()


class WriteResult:
    def __init__(self, count: int) -> None:
        self.matched_count = count
        self.modified_count = count


class MemoryCursor:
    def __init__(self, docs: list[dict]) -> None:
        self.docs = docs

    def sort(self, *args: Any, **kwargs: Any) -> "MemoryCursor":
        return self

    def skip(self, count: int) -> "MemoryCursor":
        return self

    def limit(self, count: int) -> "MemoryCursor":
        return self

    async def to_list(self, length: int | None = None) -> list[dict]:
        if length is None:
            return list(self.docs)
        return list(self.docs[:length])


class MemoryCollection:
    def __init__(self) -> None:
        self.docs: list[dict] = []

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return copy.deepcopy(document)
        return None

    async def insert_one(self, document: dict) -> None:
        self.docs.append(copy.deepcopy(document))

    async def update_one(self, query: dict, update: dict) -> WriteResult:
        for document in self.docs:
            if not _matches(document, query):
                continue
            _apply(document, update)
            return WriteResult(1)
        return WriteResult(0)

    async def find_one_and_update(
        self,
        query: dict,
        update: dict,
        return_document: Any = None,
    ) -> dict | None:
        for document in self.docs:
            if not _matches(document, query):
                continue
            before = copy.deepcopy(document)
            _apply(document, update)
            if return_document in {ReturnDocument.BEFORE, False}:
                return before
            return copy.deepcopy(document)
        return None

    def find(self, query: dict, projection: dict | None = None) -> MemoryCursor:
        return MemoryCursor(
            [copy.deepcopy(document) for document in self.docs if _matches(document, query)]
        )

    async def count_documents(self, query: dict) -> int:
        return sum(1 for document in self.docs if _matches(document, query))

    async def create_index(self, *args: Any, **kwargs: Any) -> None:
        return None


class MemoryDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, MemoryCollection] = {}

    def __getitem__(self, name: str) -> MemoryCollection:
        if name not in self.collections:
            self.collections[name] = MemoryCollection()
        return self.collections[name]


class MemoryRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(
        self,
        key: str,
        value: str,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def delete(self, key: str) -> int:
        existed = key in self.store
        self.store.pop(key, None)
        return 1 if existed else 0


class FlakyBalanceRedis(MemoryRedis):
    async def delete(self, key: str) -> int:
        if "credit_balance_check" in key:
            raise RuntimeError("cache delete failed")
        return await super().delete(key)


class FailOnceUsers(MemoryCollection):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def find_one_and_update(
        self,
        query: dict,
        update: dict,
        return_document: Any = None,
    ) -> dict | None:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("mongo down")
        return await super().find_one_and_update(
            query,
            update,
            return_document=return_document,
        )


class RaisingLedger(MemoryCollection):
    async def insert_one(self, document: dict) -> None:
        raise RuntimeError("ledger down")


def _matches(document: dict, query: dict) -> bool:
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, item) for item in expected):
                return False
            continue
        if key == "$and":
            if not all(_matches(document, item) for item in expected):
                return False
            continue
        if not _match_field(document, key, expected):
            return False
    return True


def _match_field(document: dict, key: str, expected: Any) -> bool:
    exists = key in document
    actual = document.get(key)
    if isinstance(expected, dict) and any(str(item).startswith("$") for item in expected):
        if "$exists" in expected and bool(exists) != bool(expected["$exists"]):
            return False
        if "$in" in expected and actual not in expected["$in"]:
            return False
        if "$lte" in expected and (actual is None or actual > expected["$lte"]):
            return False
        if "$gt" in expected and (actual is None or actual <= expected["$gt"]):
            return False
        if "$ne" in expected and actual == expected["$ne"]:
            return False
        return True
    if expected is None:
        return (not exists) or actual is None
    return actual == expected


def _apply(document: dict, update: dict) -> None:
    for key, value in update.get("$set", {}).items():
        document[key] = value
    for key, value in update.get("$inc", {}).items():
        document[key] = int(document.get(key) or 0) + int(value)
    for key in update.get("$unset", {}):
        document.pop(key, None)


class FakeMongo:
    def __init__(self, database: MemoryDatabase) -> None:
        self._database = database

    def __getitem__(self, name: str) -> MemoryDatabase:
        return self._database


class FakeConnections:
    def __init__(self, database: MemoryDatabase) -> None:
        self.mongo = FakeMongo(database)

    async def close(self) -> None:
        return None


def _sign_stripe(body: bytes) -> dict[str, str]:
    timestamp = str(int(time.time()))
    signed = f"{timestamp}.{body.decode()}".encode()
    digest = hmac.new(_WEBHOOK_SECRET.encode(), signed, hashlib.sha256).hexdigest()
    return {"Stripe-Signature": f"t={timestamp},v1={digest}"}


def _token(sub: str) -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> MemoryDatabase:
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "stripe_webhook_secret", _WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    return MemoryDatabase()


@pytest.fixture(autouse=True)
def memory_cache(monkeypatch: pytest.MonkeyPatch) -> MemoryRedis:
    cache = MemoryRedis()
    monkeypatch.setattr(CreditsCache, "_client_override", cache)
    return cache


def _client(database: MemoryDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _user(database: MemoryDatabase, credits: int = 0, **extra: Any) -> None:
    database["users"].docs.append(
        {"user_id": "user_abc", "user_email": "user@example.com", "credits": credits, **extra}
    )


def test_user_info_returns_three_credit_buckets_and_billing_state(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=120)
    database["subscription_user_credits"].docs.append(
        {
            "user_id": "user_abc",
            "credits_balance": 80,
            "status": "active",
            "subscription_info_id": "sub_info_1",
        }
    )
    database["gift_credits"].docs.append({"user_id": "user_abc", "amount": 30})

    response = _client(database).get(
        "/api/v2/user/info",
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["credits"] == 120
    assert data["subscription_credits"]["credits_balance"] == 80
    assert data["gift_credits"]["amount"] == 30
    assert data["total_credits"] == 230
    assert data["subscription_billing_state"] == {
        "checkout_eligible": False,
        "reason": "active_subscription",
    }


def test_gift_credits_endpoint_returns_active_gift_and_marks_notified(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=120)
    expires_at = datetime.now(UTC) + timedelta(days=7)
    database["gift_credits"].docs.append(
        {
            "gift_credit_id": "gift_active",
            "user_id": "user_abc",
            "amount": 30,
            "notify_status": "not_notified",
            "expires_at": expires_at,
        }
    )
    client = _client(database)
    headers = {"Authorization": f"Bearer {_token('user_abc')}"}

    response = client.get("/api/v1/gift_credits", headers=headers)
    notified = client.patch("/api/v1/gift_credits/notify", headers=headers)

    assert response.status_code == 200
    assert response.json()["data"]["amount"] == 30
    assert notified.status_code == 200
    assert database["gift_credits"].docs[0]["notify_status"] == "notified"


@pytest.mark.asyncio
async def test_gift_credits_grant_and_expire_write_ledger(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=120)

    await GiftCreditsService.grant_official_gift(
        database,
        user_id="user_abc",
        amount=30,
        expires_at=datetime.now(UTC) + timedelta(days=1),
        gift_credit_id="gift_expired",
        idempotency_key="welcome:user_abc",
    )
    assert (
        await UnifiedCreditsService.get_user_credits_snapshot(database, "user_abc")
    ).total_credits == 150

    expired = await GiftCreditsService.get_gift_credits(
        database,
        user_id="user_abc",
        now=datetime.now(UTC) + timedelta(days=2),
    )

    assert expired is None
    assert database["gift_credits"].docs[0]["amount"] == 0
    assert [record["event_type"] for record in _records(database)] == [
        "official_gift",
        "gift_expire",
    ]
    assert [record["direction"] for record in _records(database)] == ["in", "out"]


def test_usage_income_and_payment_histories_are_user_scoped(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=120)
    database["orders"].docs.extend(
        [
            {
                "order_id": "order_topup",
                "user_id": "user_abc",
                "amount": 500,
                "currency": "usd",
                "pay_mode": "payment",
                "pay_result": "succeeded",
                "fulfillment_status": "completed",
                "created_at": "2026-09-29T10:00:00+00:00",
            },
            {
                "order_id": "order_other",
                "user_id": "other_user",
                "amount": 900,
                "currency": "usd",
                "pay_mode": "payment",
                "pay_result": "succeeded",
                "fulfillment_status": "completed",
                "created_at": "2026-09-29T10:01:00+00:00",
            },
        ]
    )
    database["credits_inout_record"].docs.extend(
        [
            {
                "credits_inout_record_id": "income_1",
                "user_id": "user_abc",
                "credit_type": "topup",
                "event_type": "recharge",
                "direction": "in",
                "amount": 2000,
                "signed_amount": 2000,
                "balance_before": 120,
                "balance_after": 2120,
                "created_at": "2026-09-29T10:02:00+00:00",
            },
            {
                "credits_inout_record_id": "usage_out",
                "user_id": "user_abc",
                "credit_type": "usage",
                "event_type": "usage_deduct",
                "direction": "out",
                "amount": 50,
                "signed_amount": -50,
                "balance_before": 2120,
                "balance_after": 2070,
                "created_at": "2026-09-29T10:03:00+00:00",
            },
            {
                "credits_inout_record_id": "income_other",
                "user_id": "other_user",
                "credit_type": "topup",
                "event_type": "recharge",
                "direction": "in",
                "amount": 3600,
                "signed_amount": 3600,
                "balance_before": 0,
                "balance_after": 3600,
                "created_at": "2026-09-29T10:04:00+00:00",
            },
        ]
    )
    database["usage_v2"].docs.extend(
        [
            {
                "usage_id": "usage_1",
                "user_id": "user_abc",
                "credits": 50,
                "model": "test-model",
                "created_at": "2026-09-29T10:05:00+00:00",
            },
            {
                "usage_id": "usage_other",
                "user_id": "other_user",
                "credits": 90,
                "model": "other-model",
                "created_at": "2026-09-29T10:06:00+00:00",
            },
        ]
    )
    client = _client(database)
    headers = {"Authorization": f"Bearer {_token('user_abc')}"}

    payments = client.get("/api/v2/payments/history", headers=headers)
    income = client.get("/api/v2/usage/income", headers=headers)
    usage = client.get("/api/v2/usage/history", headers=headers)

    assert payments.status_code == 200
    assert [item["order_id"] for item in payments.json()["data"]["items"]] == ["order_topup"]
    assert income.status_code == 200
    assert [item["credits_inout_record_id"] for item in income.json()["data"]["items"]] == [
        "income_1"
    ]
    assert usage.status_code == 200
    assert [item["usage_id"] for item in usage.json()["data"]["items"]] == ["usage_1"]


def _payment_order(database: MemoryDatabase, *, amount: int = 1000) -> dict:
    order = {
        "order_id": "order_topup",
        "checkout_id": "cs_topup",
        "user_id": "user_abc",
        "amount": amount,
        "currency": "usd",
        "pay_result": "processing",
        "pay_status": "unpaid",
        "pay_mode": "payment",
        "type": "one_time",
        "fulfillment_status": "pending",
    }
    database["orders"].docs.append(order)
    return order


def _checkout_event(
    event_id: str,
    session: dict,
    *,
    event_type: str = "checkout.session.completed",
) -> dict:
    return {"id": event_id, "type": event_type, "data": {"object": session}}


def _paid_session(**extra: Any) -> dict:
    session = {
        "id": "cs_topup",
        "mode": "payment",
        "payment_status": "paid",
        "amount_total": 1000,
        "currency": "usd",
        "payment_intent": "pi_topup",
        "metadata": {"user_id": "attacker", "checkout_order_id": "order_topup"},
    }
    session.update(extra)
    return session


def _subscription_session(subscription_id: str = "sub_123") -> dict:
    return {
        "id": "cs_sub",
        "mode": "subscription",
        "payment_status": "paid",
        "subscription": subscription_id,
        "metadata": {"user_id": "user_abc", "checkout_order_id": "order_sub"},
    }


def _invoice_event(
    event_id: str,
    *,
    invoice_id: str = "in_123",
    billing_reason: str = "subscription_create",
    credits: str = "800",
    interval: str = "monthly",
    created: int = 1_700_000_000,
    amount_paid: int = 2000,
) -> dict:
    return {
        "id": event_id,
        "type": "invoice.paid",
        "data": {
            "object": {
                "id": invoice_id,
                "billing_reason": billing_reason,
                "amount_paid": amount_paid,
                "currency": "usd",
                "created": created,
                "subscription": {
                    "id": "sub_123",
                    "status": "active",
                    "currency": "usd",
                    "current_period_start": created,
                    "current_period_end": created + 2_592_000,
                    "metadata": {
                        "user_id": "user_abc",
                        "checkout_order_id": "order_sub",
                        "subscription_key": "starter",
                        "interval": interval,
                        "subscription_credits": credits,
                        "price_id": "price_test",
                        "level": "1",
                    },
                    "items": {"data": [{"price": {"id": "price_test"}}]},
                },
            }
        },
    }


def _records(database: MemoryDatabase) -> list[dict]:
    return database["credits_inout_record"].docs


async def _snapshot_subscription(database: MemoryDatabase) -> int:
    snapshot = await UnifiedCreditsService.get_user_credits_snapshot(database, "user_abc")
    return int(snapshot.subscription_credits_balance)


@pytest.mark.asyncio
async def test_settled_topup_grants_once_and_writes_recharge(database: MemoryDatabase) -> None:
    _user(database, credits=10)
    _payment_order(database)
    event = _checkout_event("evt_topup_1", _paid_session())

    await StripeWebhookProcessService.process(database, event)
    replay = _checkout_event("evt_topup_2", _paid_session())
    await StripeWebhookProcessService.process(database, replay)

    assert database["users"].docs[0]["credits"] == 4010
    assert database["orders"].docs[0]["fulfillment_status"] == "completed"
    assert database["orders"].docs[0]["user_id"] == "user_abc"
    recharge = [record for record in _records(database) if record["event_type"] == "recharge"]
    assert len(recharge) == 1
    assert recharge[0]["credit_type"] == "topup"
    assert recharge[0]["direction"] == "in"
    assert recharge[0]["source"] == "stripe_payment"
    assert recharge[0]["amount"] == 4000
    assert recharge[0]["balance_before"] == 10
    assert recharge[0]["balance_after"] == 4010
    assert recharge[0]["idempotency_key"] == "recharge:order_topup"
    assert credits_idempotency_key("order_topup") in CreditsCache._client_override.store


@pytest.mark.asyncio
async def test_pro_level_uses_five_hundred_credits_per_dollar(database: MemoryDatabase) -> None:
    _user(database, system_level=3)
    _payment_order(database, amount=1000)

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_pro", _paid_session()),
    )

    assert database["users"].docs[0]["credits"] == 5000


@pytest.mark.asyncio
async def test_unpaid_checkout_and_custom_workflow_do_not_change_credits(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=10)
    _payment_order(database)

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_unpaid", _paid_session(payment_status="unpaid")),
    )
    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event(
            "evt_custom",
            _paid_session(metadata={"payment_type": "custom_workflow"}),
        ),
    )

    assert database["users"].docs[0]["credits"] == 10
    assert database["orders"].docs[0]["pay_result"] == "succeeded"
    assert _records(database) == []


@pytest.mark.asyncio
async def test_async_payment_rereads_stripe_before_granting(
    database: MemoryDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _user(database, credits=0)
    _payment_order(database)

    async def unpaid(session_id: str) -> dict:
        return _paid_session(payment_status="unpaid")

    monkeypatch.setattr(checkout_module, "retrieve_stripe_checkout_session", unpaid)
    with pytest.raises(RuntimeError, match="not settled"):
        await CheckoutSessionCompletedProcessor.process_event(
            database,
            _checkout_event(
                "evt_async_open",
                _paid_session(payment_status="unpaid"),
                event_type="checkout.session.async_payment_succeeded",
            ),
        )
    assert database["users"].docs[0]["credits"] == 0

    async def paid(session_id: str) -> dict:
        return _paid_session()

    monkeypatch.setattr(checkout_module, "retrieve_stripe_checkout_session", paid)
    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event(
            "evt_async_paid",
            _paid_session(payment_status="unpaid"),
            event_type="checkout.session.async_payment_succeeded",
        ),
    )
    assert database["users"].docs[0]["credits"] == 4000


@pytest.mark.asyncio
async def test_mongo_failure_releases_idempotency_lock(database: MemoryDatabase) -> None:
    users = FailOnceUsers()
    users.docs.append({"user_id": "user_abc", "user_email": "user@example.com", "credits": 10})
    database.collections["users"] = users
    _payment_order(database)

    with pytest.raises(RuntimeError, match="mongo down"):
        await CheckoutSessionCompletedProcessor.process_event(
            database,
            _checkout_event("evt_mongo", _paid_session(amount_total=100)),
        )
    assert users.docs[0]["credits"] == 10
    assert credits_idempotency_key("order_topup") not in CreditsCache._client_override.store
    assert database["orders"].docs[0]["fulfillment_status"] == "failed"

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_mongo_retry", _paid_session(amount_total=100)),
    )
    assert users.docs[0]["credits"] == 410
    assert credits_idempotency_key("order_topup") in CreditsCache._client_override.store


@pytest.mark.asyncio
async def test_cache_delete_failure_keeps_lock_and_credits(
    database: MemoryDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = FlakyBalanceRedis()
    cache.store[credit_balance_check_key("user_abc")] = "10"
    monkeypatch.setattr(CreditsCache, "_client_override", cache)
    _user(database, credits=10)
    _payment_order(database, amount=100)

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_cache", _paid_session(amount_total=100)),
    )
    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_cache_again", _paid_session(amount_total=100)),
    )

    assert database["users"].docs[0]["credits"] == 410
    assert credit_balance_check_key("user_abc") in cache.store
    assert credits_idempotency_key("order_topup") in cache.store


@pytest.mark.asyncio
async def test_ledger_failure_does_not_roll_back_credits(database: MemoryDatabase) -> None:
    _user(database, credits=10)
    _payment_order(database, amount=100)
    database.collections["credits_inout_record"] = RaisingLedger()

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_ledger", _paid_session(amount_total=100)),
    )

    assert database["users"].docs[0]["credits"] == 410
    assert database["orders"].docs[0]["fulfillment_status"] == "completed"
    assert database["credits_inout_record"].docs == []


@pytest.mark.asyncio
async def test_one_time_subscription_grants_subscription_credits_not_topup(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=42)
    _payment_order(database, amount=9900)
    session = _paid_session(
        amount_total=9900,
        metadata={
            "is_subscription_purchase": "true",
            "subscription_credits": "12000",
            "interval": "yearly",
            "subscription_key": "starter",
            "price_id": "price_year",
        },
    )

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_onetime", session),
    )
    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_onetime_replay", session),
    )

    assert database["users"].docs[0]["credits"] == 42
    assert await _snapshot_subscription(database) == 12000
    assert not any(record["event_type"] == "recharge" for record in _records(database))
    assert sum(record["event_type"] == "subscription_grant" for record in _records(database)) == 1


@pytest.mark.asyncio
async def test_paid_invoice_grants_subscription_credits_once(database: MemoryDatabase) -> None:
    _user(database, credits=9)
    database["orders"].docs.append(
        {
            "order_id": "order_sub",
            "checkout_id": "cs_sub",
            "user_id": "user_abc",
            "amount": 0,
            "currency": "usd",
            "pay_result": "processing",
            "pay_mode": "subscription",
            "type": "recurring",
            "fulfillment_status": "pending",
        }
    )

    await CheckoutSessionCompletedProcessor.process_event(
        database,
        _checkout_event("evt_checkout_sub", _subscription_session()),
    )
    assert database["users"].docs[0]["credits"] == 9
    assert await _snapshot_subscription(database) == 0
    assert database["orders"].docs[0]["pay_result"] == "succeeded"
    assert database["orders"].docs[0]["fulfillment_status"] == "pending"

    invoice = _invoice_event("evt_invoice")
    await SubscriptionSucceedProcessor.process_event(database, invoice)
    await SubscriptionSucceedProcessor.process_event(database, _invoice_event("evt_invoice_replay"))

    assert database["users"].docs[0]["credits"] == 9
    assert await _snapshot_subscription(database) == 800
    grants = [record for record in _records(database) if record["credit_type"] == "subscription"]
    assert len(grants) == 1
    assert grants[0]["event_type"] == "subscription_grant"
    assert grants[0]["direction"] == "in"
    assert grants[0]["amount"] == 800
    assert database["yearly_subscription_credit_schedules"].docs == []


@pytest.mark.asyncio
async def test_renewal_replaces_subscription_credits_and_replay_does_not_stack(
    database: MemoryDatabase,
) -> None:
    _user(database)
    database["orders"].docs.append(
        {
            "order_id": "order_sub",
            "user_id": "user_abc",
            "pay_result": "processing",
            "pay_mode": "subscription",
            "fulfillment_status": "pending",
            "currency": "usd",
            "amount": 0,
        }
    )
    created = _invoice_event("evt_create", credits="800")
    await SubscriptionSucceedProcessor.process_event(database, created)
    await SubscriptionSucceedProcessor.process_event(
        database,
        _invoice_event(
            "evt_cycle",
            invoice_id="in_cycle",
            billing_reason="subscription_cycle",
            credits="900",
            created=1_800_000_000,
        ),
    )
    await SubscriptionSucceedProcessor.process_event(
        database,
        _invoice_event(
            "evt_cycle_replay",
            invoice_id="in_cycle",
            billing_reason="subscription_cycle",
            credits="900",
            created=1_800_000_000,
        ),
    )

    assert await _snapshot_subscription(database) == 900


@pytest.mark.asyncio
async def test_yearly_invoice_starts_monthly_schedule(database: MemoryDatabase) -> None:
    _user(database)
    database["orders"].docs.append(
        {
            "order_id": "order_sub",
            "user_id": "user_abc",
            "pay_result": "processing",
            "pay_mode": "subscription",
            "fulfillment_status": "pending",
            "currency": "usd",
            "amount": 0,
        }
    )

    await SubscriptionSucceedProcessor.process_event(
        database,
        _invoice_event("evt_year", credits="800", interval="yearly"),
    )

    assert await _snapshot_subscription(database) == 800
    schedule = database["yearly_subscription_credit_schedules"].docs[0]
    assert schedule["credit_schedule_id"] == "in_123"
    assert schedule["cycle_number"] == 1
    assert schedule["max_cycle_number"] == 12
    assert schedule["status"] == "started"


@pytest.mark.asyncio
async def test_yearly_schedule_grants_each_cycle_once(database: MemoryDatabase) -> None:
    _user(database)
    subscription_info = {
        "id": "sub_info_year",
        "user_id": "user_abc",
        "status": "active",
        "stripe_subscription_id": "sub_year",
        "subscription_metadata": {"interval": "yearly", "subscription_credits": 800},
    }
    database["subscription_info"].docs.append(subscription_info)
    database["yearly_subscription_credit_schedules"].docs.append(
        {
            "user_id": "user_abc",
            "subscription_info_id": "sub_info_year",
            "credit_schedule_id": "in_year",
            "cycle_number": 1,
            "max_cycle_number": 12,
            "credit_schedule_created": 1_800_000_000,
            "status": "started",
        }
    )
    database["subscription_user_credits"].docs.append(
        {
            "credit_grant_id": "stripe_invoice:in_year:cycle:1",
            "user_id": "user_abc",
            "status": "active",
            "cycle_number": 1,
            "settlement_created": 1_800_000_000,
            "credits_balance": 800,
        }
    )

    await SubscriptionCreditsRewardService.a_reward_yearly_cycle(
        database,
        credit_schedule_id="in_year",
        cycle_number=2,
    )
    await SubscriptionCreditsRewardService.a_reward_yearly_cycle(
        database,
        credit_schedule_id="in_year",
        cycle_number=2,
    )

    active = await database["subscription_user_credits"].find_one(
        {"user_id": "user_abc", "status": "active"}
    )
    assert active["credit_grant_id"] == "stripe_invoice:in_year:cycle:2"
    assert await _snapshot_subscription(database) == 800
    assert sum(
        1
        for item in database["subscription_user_credits"].docs
        if item.get("credit_grant_id") == "stripe_invoice:in_year:cycle:2"
    ) == 1
    assert database["yearly_subscription_credit_schedules"].docs[0]["cycle_number"] == 2


@pytest.mark.asyncio
async def test_subscription_deletion_removes_credits_from_the_total(
    database: MemoryDatabase,
) -> None:
    _user(database, credits=9)
    database["orders"].docs.append(
        {
            "order_id": "order_sub",
            "user_id": "user_abc",
            "pay_result": "processing",
            "pay_mode": "subscription",
            "fulfillment_status": "pending",
            "currency": "usd",
            "amount": 0,
        }
    )
    await SubscriptionSucceedProcessor.process_event(database, _invoice_event("evt_delete_setup"))
    await SubscriptionDeletedProcessor.process_event(
        database,
        {
            "id": "evt_deleted",
            "type": "customer.subscription.deleted",
            "data": {"object": {"id": "sub_123"}},
        },
    )

    assert database["users"].docs[0]["credits"] == 9
    assert await _snapshot_subscription(database) == 0
    assert database["subscription_info"].docs[0]["status"] == "canceled"


@pytest.mark.asyncio
async def test_local_hold_statuses_do_not_grant_subscription_credits(
    database: MemoryDatabase,
) -> None:
    for status in ("3ds_processing", "payment_failed"):
        await SubscriptionCreditsRewardService.a_reward_subscription_credits(
            database,
            {
                "id": f"sub_info_{status}",
                "user_id": "user_abc",
                "status": status,
                "subscription_metadata": {"interval": "monthly", "subscription_credits": 800},
            },
            settlement_id=f"in_{status}",
            settlement_created=1,
        )

    assert database["subscription_user_credits"].docs == []


def test_plan_change_without_invoice_does_not_change_credits(
    database: MemoryDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_create_stripe_checkout_session(settings, *, idempotency_key, payload):
        return {
            "id": "cs_plan",
            "url": "https://checkout.stripe.com/c/plan",
            "mode": payload["mode"],
            "status": "open",
        }

    monkeypatch.setattr(
        PaymentsService,
        "_create_stripe_checkout_session",
        staticmethod(fake_create_stripe_checkout_session),
    )
    _user(database, credits=9)

    response = _client(database).put(
        "/api/v2/payments/subscription/plan",
        json={
            "subscription_info_id": "sub_info_old",
            "subscription_key": "creator",
            "interval": "monthly",
            "price_id": "price_new",
            "successUrl": "https://novelcomic.test/success",
            "cancelUrl": "https://novelcomic.test/cancel",
        },
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["url"] == "https://checkout.stripe.com/c/plan"
    assert database["users"].docs[0]["credits"] == 9
    assert database["subscription_user_credits"].docs == []


def test_signed_webhook_fulfills_topup(database: MemoryDatabase) -> None:
    _user(database, credits=0)
    _payment_order(database, amount=100)
    event = _checkout_event("evt_http", _paid_session(amount_total=100))
    body = json.dumps(event).encode()

    response = _client(database).post(
        "/api/v1/payments/webhook",
        content=body,
        headers=_sign_stripe(body),
    )

    assert response.status_code == 200
    assert database["users"].docs[0]["credits"] == 400


def test_public_subscription_template_and_plan_config_routes(database: MemoryDatabase) -> None:
    client = _client(database)

    template_resp = client.get("/api/v1/payments/subscription/template")
    assert template_resp.status_code == 200
    plans = template_resp.json()["data"]["plans"]
    assert [p["key"] for p in plans] == ["starter", "creator", "pro"]

    config_resp = client.get("/api/v1/payments/subscription/stripe_plan_config")
    assert config_resp.status_code == 200
    assert config_resp.json()["data"]["pro"]["level"] == 3


def test_checkout_status_invoice_and_billing_portal_routes(database: MemoryDatabase) -> None:
    _user(database, credits=100, stripe_customer_id="cus_123")
    _payment_order(database, amount=1000)
    database["orders"].docs[0]["stripe_invoice_id"] = "in_abc"

    client = _client(database)
    headers = {"Authorization": f"Bearer {_token('user_abc')}"}

    status_resp = client.get("/api/v1/payments/checkout/cs_topup/status", headers=headers)
    assert status_resp.status_code == 200
    assert status_resp.json()["data"]["order_id"] == "order_topup"
    assert database["users"].docs[0]["credits"] == 100

    invoice_resp = client.get("/api/v1/payments/invoice?session_id=cs_topup", headers=headers)
    assert invoice_resp.status_code == 200
    assert invoice_resp.json()["data"]["invoice_id"] == "in_abc"

    portal_resp = client.get(
        "/api/v1/payments/billing_session?return_url=https://novelcomic.test/billing",
        headers=headers,
    )
    assert portal_resp.status_code == 200
    assert portal_resp.json()["data"]["url"] == "https://novelcomic.test/billing"


def test_china_payment_method_creates_one_time_subscription_checkout(
    database: MemoryDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payload: dict[str, str] = {}

    async def fake_create_stripe_checkout_session(settings, *, idempotency_key, payload):
        captured_payload.update(payload)
        return {
            "id": "cs_china_sub",
            "url": "https://checkout.stripe.com/c/china",
            "mode": payload["mode"],
            "status": "open",
        }

    monkeypatch.setattr(
        PaymentsService,
        "_create_stripe_checkout_session",
        staticmethod(fake_create_stripe_checkout_session),
    )
    _user(database, credits=0)

    response = _client(database).post(
        "/api/v2/payments/subscription/checkout",
        json={
            "subscription_key": "starter",
            "interval": "yearly",
            "price_id": "price_starter_yearly",
            "payment_method": "china",
            "successUrl": "https://novelcomic.test/success",
            "cancelUrl": "https://novelcomic.test/cancel",
        },
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )

    assert response.status_code == 200
    assert captured_payload["mode"] == "payment"
    assert captured_payload["metadata[is_subscription_purchase]"] == "true"
    assert captured_payload["metadata[subscription_credits]"] == "9600"
    assert captured_payload["payment_method_types[1]"] == "alipay"
    assert captured_payload["payment_method_types[2]"] == "wechat_pay"


@pytest.mark.asyncio
async def test_invoice_payment_action_required_sets_3ds_processing_and_plan_update_handles_3ds(
    database: MemoryDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _user(database, credits=50)
    database["subscription_info"].docs.append(
        {
            "id": "sub_info_active",
            "user_id": "user_abc",
            "stripe_subscription_id": "sub_stripe_1",
            "status": "active",
            "price_ids": ["price_starter_monthly"],
            "subscription_metadata": {
                "subscription_key": "starter",
                "interval": "monthly",
                "level": 1,
                "subscription_credits": 800,
            },
        }
    )

    await StripeWebhookProcessService.process(
        database,
        {
            "id": "evt_3ds_1",
            "type": "invoice.payment_action_required",
            "data": {"object": {"id": "in_3ds", "subscription": "sub_stripe_1"}},
        },
    )
    assert database["subscription_info"].docs[0]["status"] == "3ds_processing"
    assert await _snapshot_subscription(database) == 0

    async def fake_modify_stripe_subscription(settings, **kwargs):
        return {
            "status": "3ds_processing",
            "requires_action": True,
            "client_secret": "pi_3ds_secret_123",
        }

    monkeypatch.setattr(
        PaymentsService,
        "_modify_stripe_subscription",
        staticmethod(fake_modify_stripe_subscription),
    )

    resp = _client(database).put(
        "/api/v2/payments/subscription/plan",
        json={
            "subscription_info_id": "sub_info_active",
            "subscription_key": "pro",
            "interval": "monthly",
            "price_id": "price_pro_monthly",
            "successUrl": "https://novelcomic.test/success",
            "cancelUrl": "https://novelcomic.test/cancel",
        },
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"] == {
        "url": None,
        "requires_action": True,
        "client_secret": "pi_3ds_secret_123",
    }

