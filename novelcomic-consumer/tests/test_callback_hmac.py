"""HMAC checks for AI callbacks.

密钥为空则跳过验签；配了密钥才核对 x-oc-timestamp 和 x-oc-signature。
错误签名停在 401，进不了 finalize。
"""

from __future__ import annotations

import hashlib
import hmac
import inspect
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from app.config import Settings, get_settings
from app.main import _verify_callback_signature, create_app, lifespan
from app.services.invocation.invocation_finalizer import InvocationFinalizer
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.tasks.setup import register_maintenance_tasks


class FakeCollection:
    async def find_one(self, query: dict[str, Any]) -> None:
        del query
        return None

    async def find_one_and_update(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None

    async def update_one(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeMongo:
    def __init__(self, database: FakeDatabase) -> None:
        self.database = database

    def __getitem__(self, name: str) -> FakeDatabase:
        del name
        return self.database


class FakeConnections:
    def __init__(self, database: FakeDatabase) -> None:
        self.mongo = FakeMongo(database)
        self.redis = None


def _signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()


def _headers(
    secret: str,
    raw_body: bytes,
    *,
    timestamp: str,
    idempotency_key: str,
) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "x-oc-idempotency-key": idempotency_key,
        "x-oc-signature": _signature(secret, timestamp, raw_body),
        "x-oc-timestamp": timestamp,
    }


def _valid_body() -> bytes:
    return json.dumps(
        {
            "ai_task_id": "task-hmac-1",
            "status": "success",
            "model_id": "novelcomic-image",
            "error": None,
            "started_at": "2026-09-28T13:00:00.000Z",
            "completed_at": "2026-09-28T13:00:03.000Z",
        },
        separators=(",", ":"),
    ).encode("utf-8")


@pytest.mark.asyncio
async def test_callback_rejects_one_changed_body_byte(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "callback-secret"
    monkeypatch.setattr(get_settings(), "consumer_webhook_secret", secret)
    raw_body = _valid_body()
    timestamp = datetime.now(UTC).isoformat()
    headers = _headers(secret, raw_body, timestamp=timestamp, idempotency_key="idem-1")
    tampered = bytearray(raw_body)
    tampered[10] = tampered[10] ^ 0x01

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/callbacks/models/opencreator_ai",
            content=bytes(tampered),
            headers=headers,
        )

    assert response.status_code == 401
    assert response.json()["status"] == "invalid_signature"


@pytest.mark.asyncio
async def test_callback_rejects_timestamp_outside_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "callback-secret"
    settings = get_settings()
    monkeypatch.setattr(settings, "consumer_webhook_secret", secret)
    monkeypatch.setattr(settings, "consumer_webhook_timestamp_tolerance_seconds", 300)
    raw_body = _valid_body()
    timestamp = (datetime.now(UTC) - timedelta(seconds=301)).isoformat()
    headers = _headers(secret, raw_body, timestamp=timestamp, idempotency_key="idem-stale")

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/callbacks/models/opencreator_ai",
            content=raw_body,
            headers=headers,
        )

    assert response.status_code == 401
    assert response.json()["status"] == "invalid_signature"


@pytest.mark.asyncio
async def test_matching_hmac_enters_callback_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "callback-secret"
    monkeypatch.setattr(get_settings(), "consumer_webhook_secret", secret)
    raw_body = _valid_body()
    timestamp = datetime.now(UTC).isoformat()
    headers = _headers(secret, raw_body, timestamp=timestamp, idempotency_key="idem-ok")
    app = create_app()
    app.state.connections = FakeConnections(FakeDatabase())

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/callbacks/models/opencreator_ai",
            content=raw_body,
            headers=headers,
        )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["ai_task_id"] == "task-hmac-1"
    assert response.json()["matched"] is False


@pytest.mark.asyncio
async def test_unconfigured_webhook_secret_is_unverified_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "consumer_webhook_secret", "")
    monkeypatch.setattr(settings, "consumer_webhook_timestamp_tolerance_seconds", 300)
    raw_body = _valid_body()
    stale = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    app = create_app()
    app.state.connections = FakeConnections(FakeDatabase())

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/callbacks/models/opencreator_ai",
            content=raw_body,
            headers={
                "content-type": "application/json",
                "x-oc-idempotency-key": "idem-unverified",
                "x-oc-signature": "0" * 64,
                "x-oc-timestamp": stale,
            },
        )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["ai_task_id"] == "task-hmac-1"


def test_empty_secret_skips_signature_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "consumer_webhook_secret", "")
    assert _verify_callback_signature({}, b"{}") is True
    description = Settings.model_fields["consumer_webhook_secret"].description or ""
    assert "密钥为空则跳过验签" in description
    assert "x-oc-timestamp" in description
    assert "x-oc-signature" in description


@pytest.mark.asyncio
async def test_wrong_signature_does_not_enter_finalize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "consumer_webhook_secret", "callback-secret")
    finalized = False

    async def handle_callback_fast(*args: object, **kwargs: object) -> dict[str, object]:
        del args, kwargs
        return {"_schedule_finalize": True, "invocation_id": "inv-1"}

    async def run_finalize(*args: object, **kwargs: object) -> dict[str, str]:
        nonlocal finalized
        del args, kwargs
        finalized = True
        return {"finalize_status": "done"}

    monkeypatch.setattr(ModelInvocationService, "handle_callback_fast", handle_callback_fast)
    monkeypatch.setattr(InvocationFinalizer, "run_finalize", run_finalize)
    raw_body = _valid_body()
    app = create_app()
    app.state.connections = FakeConnections(FakeDatabase())

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/callbacks/models/opencreator_ai",
            content=raw_body,
            headers={
                "content-type": "application/json",
                "x-oc-idempotency-key": "idem-bad",
                "x-oc-signature": "0" * 64,
                "x-oc-timestamp": datetime.now(UTC).isoformat(),
            },
        )

    assert response.status_code == 401
    assert response.json()["status"] == "invalid_signature"
    assert finalized is False


def test_startup_does_not_wire_thumbnail_or_sqs() -> None:
    source = inspect.getsource(lifespan) + inspect.getsource(register_maintenance_tasks)
    assert "get_thumbnail_s3_object_key" not in source
    assert "a_send_message" not in source
