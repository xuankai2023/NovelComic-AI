import base64
import hashlib
import hmac
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services.payments import PaymentsService
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService
from app.services.webhook.processors.stripe.CheckoutSessionCompletedProcessor import (
    CheckoutSessionCompletedProcessor,
)

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"novelcomic-test-secret").decode()


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict] = []

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document: dict) -> None:
        self.docs.append(dict(document))

    async def update_one(self, query: dict, update: dict):
        for document in self.docs:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            return None
        return None

    def find(self, query: dict, projection: dict | None = None):
        return FakeCursor([dict(document) for document in self.docs if _matches(document, query)])

    async def count_documents(self, query: dict) -> int:
        return sum(1 for document in self.docs if _matches(document, query))

    async def create_index(self, *args, **kwargs) -> None:
        return None


def _matches(document: dict, query: dict) -> bool:
    return all(document.get(key) == value for key, value in query.items())


class FakeCursor:
    def __init__(self, docs: list[dict]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int):
        return self

    def skip(self, count: int):
        return self

    def limit(self, count: int):
        return self

    async def to_list(self, length: int | None = None) -> list[dict]:
        return []


class FakeDatabase:
    def __init__(self) -> None:
        self.collections = {"users": FakeCollection()}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]

    @property
    def users(self) -> FakeCollection:
        return self.collections["users"]


class FakeMongo:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database

    def __getitem__(self, name: str) -> FakeDatabase:
        return self._database


class FakeConnections:
    def __init__(self, database: FakeDatabase) -> None:
        self.mongo = FakeMongo(database)

    async def close(self) -> None:
        return None


def _sign(body: bytes) -> dict[str, str]:
    message_id = "msg_test"
    timestamp = str(int(time.time()))
    secret = base64.b64decode(_WEBHOOK_SECRET.removeprefix("whsec_"))
    signed = f"{message_id}.{timestamp}.{body.decode()}".encode()
    digest = hmac.new(secret, signed, hashlib.sha256).digest()
    return {
        "svix-id": message_id,
        "svix-timestamp": timestamp,
        "svix-signature": "v1," + base64.b64encode(digest).decode(),
    }


def _sign_stripe(body: bytes, secret: str = _WEBHOOK_SECRET) -> dict[str, str]:
    timestamp = str(int(time.time()))
    signed = f"{timestamp}.{body.decode()}".encode()
    digest = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return {"Stripe-Signature": f"t={timestamp},v1={digest}"}


def _token(sub: str) -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    store = FakeDatabase()
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "clerk_webhook_secret", _WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "stripe_webhook_secret", _WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    return store


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def test_user_created_webhook_inserts_and_skips_duplicate(database: FakeDatabase) -> None:
    client = _client(database)
    body = json.dumps(
        {
            "type": "user.created",
            "data": {
                "id": "user_abc",
                "email_addresses": [{"email_address": "user@example.com"}],
            },
        }
    ).encode()
    created = client.post("/api/v1/user/create", content=body, headers=_sign(body))
    assert created.status_code == 200
    assert database.users.docs[0]["user_id"] == "user_abc"
    assert len(database["gift_credits"].docs) == 1
    assert database["gift_credits"].docs[0]["amount"] == 500
    assert database["gift_credits"].docs[0]["metadata"]["ttl_days"] == 7

    again = client.post("/api/v1/user/create", content=body, headers=_sign(body))
    assert again.status_code == 200
    assert again.json()["msg"] == "User already exists, skip"
    assert len(database.users.docs) == 1


def test_user_created_webhook_rejects_bad_signature(database: FakeDatabase) -> None:
    client = _client(database)
    response = client.post(
        "/api/v1/user/create",
        json={"type": "user.created", "data": {"id": "user_abc"}},
    )
    assert response.status_code == 400
    assert database.users.docs == []


def test_stripe_webhook_rejects_bad_signature(database: FakeDatabase) -> None:
    client = _client(database)
    body = json.dumps({"id": "evt_bad", "type": "checkout.session.completed"}).encode()

    response = client.post(
        "/api/v1/payments/webhook",
        content=body,
        headers={"Stripe-Signature": "t=1,v1=bad"},
    )

    assert response.status_code == 400
    assert database["webhook_events"].docs == []


def test_stripe_webhook_deduplicates_successful_events(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_process_event(database, event):
        calls.append(event["id"])

    monkeypatch.setattr(
        CheckoutSessionCompletedProcessor,
        "process_event",
        classmethod(lambda cls, database, event: fake_process_event(database, event)),
    )
    client = _client(database)
    body = json.dumps({"id": "evt_123", "type": "checkout.session.completed"}).encode()

    first = client.post("/api/v1/payments/webhook", content=body, headers=_sign_stripe(body))
    second = client.post("/api/v1/payments/webhook", content=body, headers=_sign_stripe(body))

    assert first.status_code == 200
    assert first.json()["data"]["processed"] is True
    assert second.status_code == 200
    assert second.json()["data"]["duplicate"] is True
    assert calls == ["evt_123"]
    assert len(database["webhook_events"].docs) == 1
    assert database["webhook_events"].docs[0]["status"] == "succeeded"


def test_user_info_requires_jwt_and_reads_local_user(database: FakeDatabase) -> None:
    client = _client(database)
    missing_token = client.get("/api/v2/user/info")
    assert missing_token.status_code == 401

    database.users.docs.append({"user_id": "user_abc", "user_email": "user@example.com"})
    found = client.get(
        "/api/v2/user/info",
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )
    assert found.status_code == 200
    data = found.json()["data"]
    assert data["user_id"] == "user_abc"
    assert data["user_email"] == "user@example.com"
    assert data["invite_code"].startswith("NC")
    assert data["invite_summary"]["total_points"] == 0

    absent = client.get(
        "/api/v2/user/info",
        headers={"Authorization": f"Bearer {_token('user_missing')}"},
    )
    assert absent.status_code == 404
    assert absent.json()["msg"] == "User not found: user_missing"


@pytest.mark.asyncio
async def test_unified_credits_snapshot_adds_three_active_buckets(database: FakeDatabase) -> None:
    database["users"].docs.append(
        {"user_id": "user_abc", "user_email": "user@example.com", "credits": 120}
    )
    database["subscription_user_credits"].docs.append(
        {"user_id": "user_abc", "credits_balance": 80, "status": "active"}
    )
    database["gift_credits"].docs.append({"user_id": "user_abc", "amount": 30})

    snapshot = await UnifiedCreditsService.get_user_credits_snapshot(database, "user_abc")

    assert snapshot.topup_credits_display == "120"
    assert snapshot.subscription_credits_balance == 80
    assert snapshot.gift_credits_balance == 30
    assert snapshot.total_credits_display == "230"


def test_payment_checkout_creates_order_without_changing_credits(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_create_stripe_checkout_session(settings, *, idempotency_key, payload):
        assert payload["metadata[user_id]"] == "user_abc"
        assert payload["line_items[0][price_data][unit_amount]"] == "500"
        return {
            "id": "cs_test_123",
            "url": "https://checkout.stripe.com/c/pay/test",
            "mode": payload["mode"],
            "status": "open",
        }

    monkeypatch.setattr(
        PaymentsService,
        "_create_stripe_checkout_session",
        staticmethod(fake_create_stripe_checkout_session),
    )
    database["users"].docs.append(
        {"user_id": "user_abc", "user_email": "user@example.com", "credits": 42}
    )

    client = _client(database)
    response = client.post(
        "/api/v1/payments/checkout",
        json={
            "amount": 5,
            "successUrl": "https://novelcomic.test/success",
            "cancelUrl": "https://novelcomic.test/cancel",
            "user_id": "attacker",
        },
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["url"] == "https://checkout.stripe.com/c/pay/test"
    assert data["id"] == "cs_test_123"
    assert database["users"].docs[0]["credits"] == 42
    assert len(database["orders"].docs) == 1
    order = database["orders"].docs[0]
    assert order["user_id"] == "user_abc"
    assert order["amount"] == 500
    assert order["checkout_id"] == "cs_test_123"
    assert order["pay_result"] == "processing"


def test_subscription_checkout_creates_order_without_changing_credits(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_create_stripe_checkout_session(settings, *, idempotency_key, payload):
        assert payload["mode"] == "subscription"
        assert payload["metadata[user_id]"] == "user_abc"
        assert payload["line_items[0][price]"] == "price_test"
        return {
            "id": "cs_sub_123",
            "url": "https://checkout.stripe.com/c/sub/test",
            "mode": payload["mode"],
            "status": "open",
        }

    monkeypatch.setattr(
        PaymentsService,
        "_create_stripe_checkout_session",
        staticmethod(fake_create_stripe_checkout_session),
    )
    database["users"].docs.append(
        {"user_id": "user_abc", "user_email": "user@example.com", "credits": 9}
    )

    client = _client(database)
    response = client.post(
        "/api/v2/payments/subscription/checkout",
        json={
            "successUrl": "https://novelcomic.test/success",
            "cancelUrl": "https://novelcomic.test/cancel",
            "subscription_key": "starter",
            "interval": "monthly",
            "price_id": "price_test",
        },
        headers={"Authorization": f"Bearer {_token('user_abc')}"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["url"] == "https://checkout.stripe.com/c/sub/test"
    assert database["users"].docs[0]["credits"] == 9
    order = database["orders"].docs[0]
    assert order["user_id"] == "user_abc"
    assert order["pay_mode"] == "subscription"
    assert order["fulfillment_status"] == "pending"
