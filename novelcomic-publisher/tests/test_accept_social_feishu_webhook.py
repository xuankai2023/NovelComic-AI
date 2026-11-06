"""Acceptance for social auth, posting, Feishu inbound commands, and outbound boundaries."""

import asyncio
import base64
import hashlib
import json
import time
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import padding, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi.testclient import TestClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.database.connections import Connections
from app.main import create_app
from app.services.b2b_signal.service import B2BSignalService
from app.services.feishu.feishu_bot_service import FeishuBotService
from app.services.unified_credits.credits_cache import CreditsCache
from app.services.webhook.processors.stripe.CheckoutSessionCompletedProcessor import (
    CheckoutSessionCompletedProcessor,
)
from app.social.poster.tiktok_poster import POST_VIDEO_URL as TIKTOK_POST_URL
from app.social.poster.x_poster import POST_CREATION_URL as X_TWEET_URL
from app.social.poster.youtube_poster import POST_VIDEO_URL as YOUTUBE_POST_URL
from app.social.provider.__base.redis_keys import (
    TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX,
    TIKTOK_AUTH_REDIS_KEY_PREFIX,
    TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    X_ACCESS_TOKEN_REDIS_KEY_PREFIX,
    YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX,
)
from app.social.provider.tiktok_provider import tiktok_provider

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_USER_ID = "user_abc"
_EMAIL = "user@example.com"
_REDIRECT = "https://app.example/oauth/callback"
_VIDEO_URL = "https://cdn.example/clip.mp4"
_STATE_TTL = 60 * 5
_ACCESS_TTL = 60 * 60 * 23
_REFRESH_TTL = 60 * 60 * 24 * 364
_FEISHU_TOKEN = "verify-token"
_FEISHU_KEY = "encrypt-key"


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, item) for item in expected):
                return False
            continue
        if key == "$and":
            if not all(_matches(document, item) for item in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict) and any(str(item).startswith("$") for item in expected):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$nin" in expected and actual in expected["$nin"]:
                return False
            if "$lte" in expected and (actual is None or actual > expected["$lte"]):
                return False
            continue
        if actual != expected:
            return False
    return True


def _apply(document: dict[str, Any], update: dict[str, Any], *, is_insert: bool) -> None:
    if is_insert:
        document.update(update.get("$setOnInsert", {}))
    document.update(update.get("$set", {}))
    for key, value in update.get("$inc", {}).items():
        document[key] = int(document.get(key) or 0) + int(value)
    for key in update.get("$unset", {}):
        document.pop(key, None)


class MemoryCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        if length is None:
            return list(self.docs)
        return list(self.docs[:length])


class MemoryCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def find_one(self, query: dict[str, Any], projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(dict(document))

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        for document in self.docs:
            if not _matches(document, query):
                continue
            _apply(document, update, is_insert=False)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        upsert: bool = False,
        return_document: Any = None,
        **kwargs: Any,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if not _matches(document, query):
                continue
            before = dict(document)
            _apply(document, update, is_insert=False)
            if return_document == ReturnDocument.BEFORE:
                return before
            return dict(document)

        if not upsert:
            return None
        if "_id" in query and not isinstance(query["_id"], dict):
            for document in self.docs:
                if document.get("_id") == query["_id"]:
                    raise DuplicateKeyError("duplicate _id")

        inserted = {
            key: value
            for key, value in query.items()
            if not isinstance(value, dict)
        }
        _apply(inserted, update, is_insert=True)
        self.docs.append(inserted)
        return dict(inserted)

    def find(self, query: dict[str, Any], projection: dict | None = None) -> MemoryCursor:
        return MemoryCursor([dict(document) for document in self.docs if _matches(document, query)])

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
        self.values: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def setex(self, key: str, ttl: int, value: str) -> None:
        self.values[key] = value
        self.ttls[key] = int(ttl)

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if key in self.values:
                self.values.pop(key, None)
                self.ttls.pop(key, None)
                removed += 1
        return removed

    async def set(
        self,
        key: str,
        value: str,
        ex: int | None = None,
        nx: bool = False,
    ) -> bool | None:
        if nx and key in self.values:
            return None
        self.values[key] = value
        if ex is not None:
            self.ttls[key] = int(ex)
        return True


class FakeMongo:
    def __init__(self, database: MemoryDatabase) -> None:
        self._database = database

    def __getitem__(self, name: str) -> MemoryDatabase:
        return self._database


class FakeConnections:
    def __init__(self, database: MemoryDatabase, redis: MemoryRedis) -> None:
        self.mongo = FakeMongo(database)
        self.redis = redis

    async def close(self) -> None:
        return None


class SocialHttp:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.fail_youtube = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if self.fail_youtube and "googleapis.com" in url:
            return httpx.Response(500, json={"error": "youtube failed"})
        if request.method == "GET":
            return httpx.Response(200, content=b"video-bytes")
        if "googleapis.com" in url and request.method == "POST":
            return httpx.Response(200, headers={"Location": "https://upload.example/session"})
        if url.startswith("https://upload.example"):
            return httpx.Response(200, json={"id": "video-1"})
        if url.endswith("/initialize"):
            return httpx.Response(200, json={"data": {"id": "media-77"}})
        return httpx.Response(200, json={"data": {"id": "ok"}})


def _tracking_client(transport: httpx.BaseTransport) -> type[httpx.AsyncClient]:
    class BoundClient(httpx.AsyncClient):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    return BoundClient


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    database = MemoryDatabase()
    redis = MemoryRedis()
    connections = FakeConnections(database, redis)
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "clerk_webhook_secret", "whsec_social_feishu")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_social_feishu")
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    monkeypatch.setattr(settings, "feishu_verification_token", _FEISHU_TOKEN)
    monkeypatch.setattr(settings, "feishu_encrypt_key", _FEISHU_KEY)
    monkeypatch.setattr(settings, "feishu_max_credits_per_operation", 1_000_000)
    monkeypatch.setattr(settings, "feishu_bot_webhook", "https://feishu.example/bot")

    async def connect(_settings: Any) -> FakeConnections:
        return connections

    monkeypatch.setattr(Connections, "connect", connect)
    monkeypatch.setattr(CreditsCache, "_client_override", redis)
    return SimpleNamespace(
        database=database,
        redis=redis,
        settings=settings,
        connections=connections,
    )


@pytest.fixture
def scheduled(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, tuple, dict]]:
    tasks: list[tuple[Any, tuple, dict]] = []

    def capture(self: Any, func: Any, *args: Any, **kwargs: Any) -> None:
        tasks.append((func, args, kwargs))

    monkeypatch.setattr("app.controller.v1.feishu.BackgroundTasks.add_task", capture)
    return tasks


@pytest.fixture
def receipts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    sent: list[str] = []

    async def send_text(text: str) -> bool:
        sent.append(text)
        return True

    monkeypatch.setattr(FeishuBotService, "send_text", staticmethod(send_text))
    return sent


@pytest.fixture
def social_http(monkeypatch: pytest.MonkeyPatch) -> SocialHttp:
    transport_state = SocialHttp()
    client_cls = _tracking_client(httpx.MockTransport(transport_state.handler))
    for module in (
        "app.social.poster.tiktok_poster",
        "app.social.poster.youtube_poster",
        "app.social.poster.x_poster",
    ):
        monkeypatch.setattr(f"{module}.httpx.AsyncClient", client_cls)
    return transport_state


def _token(sub: str = _USER_ID) -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {_token()}"}


def _client(runtime: SimpleNamespace) -> TestClient:
    app = create_app()
    app.state.connections = runtime.connections
    return TestClient(app)


def _user(database: MemoryDatabase, *, credits: int = 20, system_level: int = 0) -> None:
    database["users"].docs.append(
        {
            "user_id": _USER_ID,
            "user_email": _EMAIL,
            "credits": credits,
            "system_level": system_level,
        }
    )


def _run(tasks: list[tuple[Any, tuple, dict]]) -> None:
    for func, args, kwargs in tasks:
        asyncio.run(func(*args, **kwargs))


def _encrypt_feishu(payload: dict[str, Any]) -> str:
    key = hashlib.sha256(_FEISHU_KEY.encode("utf-8")).digest()
    iv = b"0123456789abcdef"
    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(json.dumps(payload).encode("utf-8")) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(iv + ciphertext).decode()


def _feishu_event(
    *,
    event_id: str,
    text: str,
    message_id: str = "om_1",
    message_type: str = "text",
    sender_type: str = "user",
    mentions: bool = True,
    token: str = _FEISHU_TOKEN,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "message_id": message_id,
        "create_time": "1710000000000",
        "chat_id": "oc_1",
        "chat_type": "group",
        "message_type": message_type,
        "content": json.dumps({"text": text}, ensure_ascii=False),
    }
    if mentions:
        message["mentions"] = [
            {"key": "@_user_1", "id": {"open_id": "ou_bot"}, "name": "bot"}
        ]
    return {
        "schema": "2.0",
        "header": {
            "event_id": event_id,
            "event_type": "im.message.receive_v1",
            "create_time": "1710000000000",
            "token": token,
            "app_id": "cli_test",
            "tenant_key": "tenant",
        },
        "event": {
            "sender": {
                "sender_id": {"open_id": "ou_user"},
                "sender_type": sender_type,
                "tenant_key": "tenant",
            },
            "message": message,
        },
    }


def _post_item(integration: str) -> dict[str, str]:
    return {
        "integration": integration,
        "text": f"{integration} title",
        "description": f"{integration} description",
        "video_url": _VIDEO_URL,
    }


def _json_body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content.decode())


def test_unauthenticated_social_routes_are_rejected(runtime: SimpleNamespace) -> None:
    client = _client(runtime)
    generate = client.get(
        "/api/v1/social_auth/generate_auth_url/tiktok",
        params={"redirect_uri": _REDIRECT},
    )
    callback = client.get(
        "/api/v1/social_auth/callback/tiktok",
        params={"code": "code-1", "state": "state-1", "redirect_uri": _REDIRECT},
    )
    post = client.post(
        "/api/v1/social_auth/post_video",
        json={"post_items": [_post_item("tiktok")]},
    )

    for response in (generate, callback, post):
        assert response.status_code == 401
        assert response.json()["code"] == 1002
        assert response.json()["msg"] == "Authorization field is required"
    assert runtime.redis.values == {}


def test_logged_in_user_gets_tiktok_auth_url_and_five_minute_state(
    runtime: SimpleNamespace,
) -> None:
    response = _client(runtime).get(
        "/api/v1/social_auth/generate_auth_url/tiktok",
        params={"redirect_uri": _REDIRECT},
        headers=_auth(),
    )

    assert response.status_code == 200
    auth_url = response.json()["data"]
    assert auth_url.startswith("https://www.tiktok.com/v2/auth/authorize/")
    state = parse_qs(urlparse(auth_url).query)["state"][0]
    key = TIKTOK_AUTH_REDIS_KEY_PREFIX + _USER_ID
    assert runtime.redis.values[key] == state
    assert runtime.redis.ttls[key] == _STATE_TTL
    assert len(state) == 32


def test_state_mismatch_does_not_exchange_token(
    runtime: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = TIKTOK_AUTH_REDIS_KEY_PREFIX + _USER_ID
    runtime.redis.values[key] = "expected-state"
    runtime.redis.ttls[key] = _STATE_TTL

    async def forbid_exchange(*args: Any, **kwargs: Any) -> dict[str, str]:
        raise AssertionError("state mismatch must not exchange a code")

    monkeypatch.setattr(tiktok_provider, "get_token", forbid_exchange)
    response = _client(runtime).get(
        "/api/v1/social_auth/callback/tiktok",
        params={"code": "code-1", "state": "other-state", "redirect_uri": _REDIRECT},
        headers=_auth(),
    )

    assert response.status_code == 400
    assert response.json()["msg"] == "OAuth state mismatch"
    assert runtime.redis.values[key] == "expected-state"
    assert TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID not in runtime.redis.values
    assert TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX + _USER_ID not in runtime.redis.values


def test_matching_state_stores_tokens_and_deletes_state(
    runtime: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_key = TIKTOK_AUTH_REDIS_KEY_PREFIX + _USER_ID
    runtime.redis.values[auth_key] = "expected-state"

    async def exchange(code: str, redirect_uri: str) -> dict[str, str]:
        assert code == "code-1"
        assert redirect_uri == _REDIRECT
        return {"access_token": "access-1", "refresh_token": "refresh-1"}

    monkeypatch.setattr(tiktok_provider, "get_token", exchange)
    response = _client(runtime).get(
        "/api/v1/social_auth/callback/tiktok",
        params={"code": "code-1", "state": "expected-state", "redirect_uri": _REDIRECT},
        headers=_auth(),
    )

    access_key = TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID
    refresh_key = TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX + _USER_ID
    assert response.status_code == 200
    assert response.json()["data"] == "Auth Successful!"
    assert auth_key not in runtime.redis.values
    assert runtime.redis.values[access_key] == "access-1"
    assert runtime.redis.values[refresh_key] == "refresh-1"
    assert runtime.redis.ttls[access_key] == _ACCESS_TTL
    assert runtime.redis.ttls[refresh_key] == _REFRESH_TTL


def test_post_video_fails_without_access_token(
    runtime: SimpleNamespace,
    social_http: SocialHttp,
) -> None:
    response = _client(runtime).post(
        "/api/v1/social_auth/post_video",
        headers=_auth(),
        json={"post_items": [_post_item("tiktok")]},
    )

    assert response.status_code == 500
    assert response.json()["code"] == 1007
    assert "Access token not found" in response.json()["msg"]
    assert social_http.requests == []
    assert runtime.database["workflow_events"].docs == []


def test_platform_post_payloads_do_not_advance_workflow_nodes(
    runtime: SimpleNamespace,
    social_http: SocialHttp,
) -> None:
    runtime.redis.values[TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID] = "tiktok-access"
    runtime.redis.values[YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID] = "youtube-access"
    runtime.redis.values[X_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID] = "x-access"
    client = _client(runtime)

    tiktok = client.post(
        "/api/v1/social_auth/post_video",
        headers=_auth(),
        json={"post_items": [_post_item("tiktok")]},
    )
    youtube = client.post(
        "/api/v1/social_auth/post_video",
        headers=_auth(),
        json={"post_items": [_post_item("youtube")]},
    )
    x_post = client.post(
        "/api/v1/social_auth/post_video",
        headers=_auth(),
        json={"post_items": [_post_item("x")]},
    )

    assert tiktok.status_code == 200
    assert youtube.status_code == 200
    assert x_post.status_code == 200
    tiktok_call = next(item for item in social_http.requests if str(item.url) == TIKTOK_POST_URL)
    tiktok_body = _json_body(tiktok_call)
    assert tiktok_call.method == "POST"
    assert tiktok_body["source_info"] == {"source": "PULL_FROM_URL", "video_url": _VIDEO_URL}
    assert tiktok_body["post_info"]["privacy_level"] == "SELF_ONLY"
    youtube_init = next(
        item
        for item in social_http.requests
        if str(item.url).startswith(YOUTUBE_POST_URL) and item.method == "POST"
    )
    assert _json_body(youtube_init)["status"]["privacyStatus"] == "private"
    tweet = next(item for item in social_http.requests if str(item.url) == X_TWEET_URL)
    assert _json_body(tweet)["media"]["media_ids"] == ["media-77"]
    assert runtime.database["workflow_events"].docs == []


def test_multi_platform_post_fails_when_any_platform_fails(
    runtime: SimpleNamespace,
    social_http: SocialHttp,
) -> None:
    runtime.redis.values[TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID] = "tiktok-access"
    runtime.redis.values[YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID] = "youtube-access"
    social_http.fail_youtube = True

    response = _client(runtime).post(
        "/api/v1/social_auth/post_video",
        headers=_auth(),
        json={"post_items": [_post_item("tiktok"), _post_item("youtube")]},
    )

    assert response.status_code == 500
    assert response.json()["code"] == 1007
    assert response.json()["msg"] != "Videos posted successfully"
    assert any("googleapis.com" in str(item.url) for item in social_http.requests)


def test_social_webhook_is_public_and_does_not_change_tokens(runtime: SimpleNamespace) -> None:
    access_key = TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + _USER_ID
    refresh_key = TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX + _USER_ID
    runtime.redis.values[access_key] = "access-1"
    runtime.redis.values[refresh_key] = "refresh-1"
    runtime.redis.ttls[access_key] = _ACCESS_TTL
    runtime.redis.ttls[refresh_key] = _REFRESH_TTL

    response = _client(runtime).get("/api/v1/social_auth/webhooks/tiktok")

    assert response.status_code == 200
    assert response.json()["data"] == "ok"
    assert runtime.redis.values[access_key] == "access-1"
    assert runtime.redis.values[refresh_key] == "refresh-1"
    assert runtime.redis.ttls[access_key] == _ACCESS_TTL
    assert runtime.redis.ttls[refresh_key] == _REFRESH_TTL


def test_feishu_challenge_and_decrypt_failure(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
) -> None:
    client = _client(runtime)
    challenge = client.post(
        "/api/v1/feishu/event",
        json={
            "encrypt": _encrypt_feishu(
                {"type": "url_verification", "challenge": "chk_123"}
            )
        },
    )
    rejected = client.post("/api/v1/feishu/event", json={"encrypt": "not-a-feishu-cipher"})

    assert challenge.status_code == 200
    assert challenge.json() == {"challenge": "chk_123"}
    assert rejected.status_code == 200
    assert rejected.json()["code"] == 1
    assert scheduled == []


def test_feishu_event_http_succeeds_before_the_command_runs(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
) -> None:
    _user(runtime.database, system_level=0)
    response = _client(runtime).post(
        "/api/v1/feishu/event",
        json=_feishu_event(event_id="evt-plan", text=f"email={_EMAIL} plan=pro"),
    )

    assert response.status_code == 200
    assert response.json() == {"code": 0, "msg": "success"}
    assert runtime.database["users"].docs[0]["system_level"] == 0
    assert receipts == []

    _run(scheduled)

    assert runtime.database["users"].docs[0]["system_level"] == 3
    assert receipts == [f"{_EMAIL} 已调整为 pro，system_level=3"]
    assert runtime.database["workflow_events"].docs == []


def test_ignored_feishu_messages_do_not_change_the_user(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
) -> None:
    _user(runtime.database, credits=20, system_level=0)
    client = _client(runtime)
    payloads = [
        _feishu_event(event_id="evt-no-mention", text=f"email={_EMAIL} plan=pro", mentions=False),
        _feishu_event(
            event_id="evt-image",
            text=f"email={_EMAIL} plan=pro",
            message_type="image",
        ),
        _feishu_event(
            event_id="evt-bot",
            text=f"email={_EMAIL} credits=10 remake=bot",
            sender_type="app",
        ),
    ]
    for payload in payloads:
        response = client.post("/api/v1/feishu/event", json=payload)
        assert response.status_code == 200
        assert response.json()["code"] == 0

    _run(scheduled)

    user = runtime.database["users"].docs[0]
    assert user["system_level"] == 0
    assert user["credits"] == 20
    assert receipts == []
    assert runtime.database["credits_inout_record"].docs == []


@pytest.mark.parametrize(
    ("plan", "level"),
    [("starter", 1), ("creator", 2), ("pro", 3)],
)
def test_feishu_plan_command_sets_system_level(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
    plan: str,
    level: int,
) -> None:
    _user(runtime.database, system_level=0)
    client = _client(runtime)
    response = client.post(
        "/api/v1/feishu/event",
        json=_feishu_event(event_id=f"evt-{plan}", text=f"email={_EMAIL} plan={plan}"),
    )
    assert response.json() == {"code": 0, "msg": "success"}

    _run(scheduled)

    assert runtime.database["users"].docs[0]["system_level"] == level
    assert receipts == [f"{_EMAIL} 已调整为 {plan}，system_level={level}"]


def test_feishu_credit_limit_ledger_and_receipt(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
) -> None:
    _user(runtime.database, credits=20)
    client = _client(runtime)
    over_limit = client.post(
        "/api/v1/feishu/event",
        json=_feishu_event(
            event_id="evt-over",
            message_id="om_over",
            text=f"email={_EMAIL} credits=1000001 remake=too-much",
        ),
    )
    assert over_limit.json()["code"] == 0
    _run(scheduled)
    scheduled.clear()

    user = runtime.database["users"].docs[0]
    assert user["credits"] == 20
    assert runtime.database["credits_inout_record"].docs == []
    assert runtime.database["credits_topup_record"].docs == []
    assert receipts == [f"{_EMAIL} 加积分失败：单次积分不能超过 1000000"]

    accepted = client.post(
        "/api/v1/feishu/event",
        json=_feishu_event(
            event_id="evt-credits",
            message_id="om_credits",
            text=f"email={_EMAIL} credits=100 remake=活动补发",
        ),
    )
    assert accepted.json() == {"code": 0, "msg": "success"}
    _run(scheduled)

    assert runtime.database["users"].docs[0]["credits"] == 120
    ledger = runtime.database["credits_inout_record"].docs[0]
    topup = runtime.database["credits_topup_record"].docs[0]
    assert ledger["event_type"] == "feishu_topup"
    assert ledger["source_id"] == "feishu_om_credits"
    assert topup["topup_source"] == "feishu"
    assert topup["idempotency_key"] == "feishu_om_credits"
    assert topup["source_id"] == "om_credits"
    assert topup["amount"] == 100
    assert "opencreator:credits:idempotency:feishu_om_credits" in runtime.redis.values
    assert receipts[-1] == f"{_EMAIL} 已增加 100 积分，备注：活动补发"
    assert runtime.database["workflow_events"].docs == []


def test_feishu_replay_does_not_repeat_and_invalid_token_can_retry(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
) -> None:
    _user(runtime.database, credits=20, system_level=0)
    client = _client(runtime)
    payload = _feishu_event(
        event_id="evt-replay",
        message_id="om_replay",
        text=f"email={_EMAIL} plan=creator",
    )
    assert client.post("/api/v1/feishu/event", json=payload).json()["code"] == 0
    assert client.post("/api/v1/feishu/event", json=payload).json()["code"] == 0
    _run(scheduled)
    scheduled.clear()

    assert runtime.database["users"].docs[0]["system_level"] == 2
    assert receipts == [f"{_EMAIL} 已调整为 creator，system_level=2"]

    credits_payload = _feishu_event(
        event_id="evt-credit-replay",
        message_id="om_credit_replay",
        text=f"email={_EMAIL} credits=15 remake=first",
    )
    client.post("/api/v1/feishu/event", json=credits_payload)
    client.post("/api/v1/feishu/event", json=credits_payload)
    _run(scheduled)
    scheduled.clear()
    assert runtime.database["users"].docs[0]["credits"] == 35
    assert len(runtime.database["credits_inout_record"].docs) == 1

    invalid = _feishu_event(
        event_id="evt-retry",
        message_id="om_retry",
        text=f"email={_EMAIL} credits=5 remake=retry",
        token="wrong-token",
    )
    client.post("/api/v1/feishu/event", json=invalid)
    _run(scheduled)
    scheduled.clear()
    assert "feishu:event:dedup:evt-retry" not in runtime.redis.values
    assert runtime.database["users"].docs[0]["credits"] == 35

    invalid["header"]["token"] = _FEISHU_TOKEN
    client.post("/api/v1/feishu/event", json=invalid)
    _run(scheduled)
    assert "feishu:event:dedup:evt-retry" in runtime.redis.values
    assert runtime.database["users"].docs[0]["credits"] == 40


def test_b2b_sent_signal_is_not_resent_and_failed_signal_can_retry(
    runtime: SimpleNamespace,
) -> None:
    action = {
        "action_id": "b2b_upgrade_consultation",
        "user_id": "user-1",
        "status": "pending",
        "title": "团队创作加速包",
        "description": "预约顾问",
        "cta_text": "预约顾问",
        "cta_url": "https://www.feishu.cn",
    }

    class RecordingClient:
        def __init__(self, fail: bool = False) -> None:
            self.fail = fail
            self.sent: list[dict[str, Any]] = []

        async def send_expiring_action_card(self, card_action: dict[str, Any]) -> dict[str, int]:
            self.sent.append(dict(card_action))
            if self.fail:
                raise RuntimeError("feishu rejected card")
            return {"code": 0}

    sent_client = RecordingClient()
    first = asyncio.run(
        B2BSignalService._notify_signal_if_needed(
            runtime.database,
            action=action,
            trigger_event_id="event-1",
            feishu_client=sent_client,
        )
    )
    second = asyncio.run(
        B2BSignalService._notify_signal_if_needed(
            runtime.database,
            action=action,
            trigger_event_id="event-2",
            feishu_client=sent_client,
        )
    )
    sent_notification = runtime.database["b2b_signal_notifications"].docs[0]
    assert first is True
    assert second is False
    assert len(sent_client.sent) == 1
    assert sent_notification["status"] == "sent"

    failed_database = MemoryDatabase()
    failed_client = RecordingClient(fail=True)
    ok_client = RecordingClient()
    failed = asyncio.run(
        B2BSignalService._notify_signal_if_needed(
            failed_database,
            action=action,
            trigger_event_id="event-1",
            feishu_client=failed_client,
        )
    )
    retried = asyncio.run(
        B2BSignalService._notify_signal_if_needed(
            failed_database,
            action=action,
            trigger_event_id="event-2",
            feishu_client=ok_client,
        )
    )
    notification = failed_database["b2b_signal_notifications"].docs[0]
    assert failed is False
    assert retried is True
    assert len(failed_client.sent) == 1
    assert len(ok_client.sent) == 1
    assert notification["status"] == "sent"
    assert "error" not in notification


def test_custom_order_lark_failure_keeps_completed_order(
    runtime: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime.database["orders"].docs.append(
        {
            "order_id": "order-custom-1",
            "checkout_id": "cs_custom_1",
            "user_id": _USER_ID,
            "pay_result": "processing",
            "amount": 9900,
            "currency": "usd",
            "customer_email": "buyer@example.com",
            "service_type": "video_8s",
        }
    )
    calls: list[str] = []

    class TimeoutClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> "TimeoutClient":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, json: dict[str, Any]) -> None:
            calls.append(url)
            raise httpx.TimeoutException("lark timeout")

    monkeypatch.setattr(runtime.settings, "lark_custom_order_webhook_url", "https://lark.example/hook")
    monkeypatch.setattr("app.utils.lark_notify.httpx.AsyncClient", TimeoutClient)
    event = {
        "id": "evt_custom_1",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_custom_1",
                "mode": "payment",
                "payment_status": "paid",
                "amount_total": 9900,
                "currency": "usd",
                "customer_email": "buyer@example.com",
                "payment_intent": {
                    "id": "pi_custom_1",
                    "status": "succeeded",
                    "metadata": {
                        "payment_type": "custom_workflow",
                        "service_type": "video_8s",
                    },
                },
            }
        },
    }

    asyncio.run(CheckoutSessionCompletedProcessor.process_event(runtime.database, event))

    order = runtime.database["orders"].docs[0]
    assert calls == ["https://lark.example/hook"]
    assert order["pay_result"] == "succeeded"
    assert order["pay_status"] == "paid"


def test_feishu_body_is_rejected_by_clerk_and_stripe_signatures(
    runtime: SimpleNamespace,
) -> None:
    _user(runtime.database, credits=20, system_level=1)
    runtime.database["orders"].docs.append(
        {
            "order_id": "order-keep",
            "checkout_id": "cs_keep",
            "pay_result": "processing",
            "user_id": _USER_ID,
        }
    )
    body = json.dumps(
        {
            "encrypt": _encrypt_feishu(
                _feishu_event(
                    event_id="evt-cross",
                    message_id="om_cross",
                    text=f"email={_EMAIL} credits=80 remake=cross",
                )
            )
        }
    ).encode()
    client = _client(runtime)

    clerk = client.post(
        "/api/v1/user/create",
        content=body,
        headers={"content-type": "application/json"},
    )
    stripe = client.post(
        "/api/v1/payments/webhook",
        content=body,
        headers={"content-type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef"},
    )

    assert clerk.status_code == 400
    assert stripe.status_code == 400
    assert runtime.database["users"].docs[0]["credits"] == 20
    assert runtime.database["users"].docs[0]["system_level"] == 1
    assert runtime.database["orders"].docs[0]["pay_result"] == "processing"
    assert runtime.database["credits_inout_record"].docs == []
    assert runtime.database["webhook_events"].docs == []


def test_clerk_headers_on_feishu_event_do_not_change_credits(
    runtime: SimpleNamespace,
    scheduled: list[tuple[Any, tuple, dict]],
    receipts: list[str],
) -> None:
    _user(runtime.database, credits=20, system_level=1)
    body = json.dumps(
        {
            "type": "user.created",
            "data": {
                "id": "user_from_clerk",
                "email_addresses": [{"email_address": "clerk@example.com"}],
            },
        }
    ).encode()
    response = _client(runtime).post(
        "/api/v1/feishu/event",
        content=body,
        headers={
            "content-type": "application/json",
            "svix-id": "msg_clerk",
            "svix-timestamp": "1710000000",
            "svix-signature": "v1,not-a-feishu-signature",
        },
    )

    assert response.status_code == 200
    assert "challenge" not in response.json()
    _run(scheduled)
    assert runtime.database["users"].docs[0]["credits"] == 20
    assert runtime.database["users"].docs[0]["system_level"] == 1
    assert len(runtime.database["users"].docs) == 1
    assert runtime.database["credits_inout_record"].docs == []
    assert receipts == []
