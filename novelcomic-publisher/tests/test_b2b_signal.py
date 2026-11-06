import time
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.main import create_app
from app.services.b2b_signal.service import B2BSignalService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, value in query.items():
        current = document.get(key)
        if isinstance(value, dict):
            if "$nin" in value and current in value["$nin"]:
                return False
            if "$in" in value and current not in value["$in"]:
                return False
            continue
        if current != value:
            return False
    return True


def _apply_update(document: dict[str, Any], update: dict[str, Any], *, is_insert: bool) -> None:
    if is_insert:
        document.update(update.get("$setOnInsert", {}))
    document.update(update.get("$set", {}))
    for key in update.get("$unset", {}):
        document.pop(key, None)


def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
    result = dict(document)
    if not projection:
        return result
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = [dict(doc) for doc in docs]

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        return self.docs[:length] if length is not None else self.docs


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(dict(document))

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        return FakeCursor(
            [_project(document, projection) for document in self.docs if _matches(document, query)]
        )

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
    ) -> SimpleNamespace:
        matched = 0
        for document in self.docs:
            if not _matches(document, query):
                continue
            _apply_update(document, update, is_insert=False)
            matched += 1
        return SimpleNamespace(matched_count=matched, modified_count=matched)

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
        return_document: ReturnDocument = ReturnDocument.BEFORE,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if not _matches(document, query):
                continue
            before = dict(document)
            _apply_update(document, update, is_insert=False)
            return dict(document) if return_document == ReturnDocument.AFTER else before

        if not upsert:
            return None

        if "_id" in query and not isinstance(query["_id"], dict):
            for document in self.docs:
                if document.get("_id") == query["_id"]:
                    raise DuplicateKeyError("duplicate _id")

        inserted = {
            key: value
            for key, value in query.items()
            if not isinstance(value, dict) and key != "_id"
        }
        if "_id" in query and not isinstance(query["_id"], dict):
            inserted["_id"] = query["_id"]
        _apply_update(inserted, update, is_insert=True)
        self.docs.append(inserted)
        return dict(inserted) if return_document == ReturnDocument.AFTER else None


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "b2b_signal_events": FakeCollection(),
            "b2b_signal_actions": FakeCollection(),
        }

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


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


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    store = FakeDatabase()
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    return store


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _token(sub: str = "user-1", email: str = "user@example.com") -> str:
    encoded = jwt.encode(
        {"sub": sub, "email": email, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str = "user-1") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


class FakeFeishuClient:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.sent_actions: list[dict[str, Any]] = []

    async def send_expiring_action_card(self, action: dict[str, Any]) -> dict[str, Any]:
        self.sent_actions.append(dict(action))
        if self.fail:
            raise RuntimeError("feishu rejected card")
        return {"code": 0}


def _action(user_id: str = "user-1") -> dict[str, Any]:
    now = datetime(2026, 9, 28, tzinfo=UTC)
    return {
        "action_id": "b2b_upgrade_consultation",
        "user_id": user_id,
        "status": "pending",
        "title": "团队创作加速包",
        "description": "检测到你正在高频使用创作工作流，可以预约顾问获取团队额度与交付支持。",
        "cta_text": "预约顾问",
        "cta_url": "https://www.feishu.cn",
        "created_at": now,
        "updated_at": now,
    }


@pytest.mark.asyncio
async def test_b2b_signal_creates_upgrade_action_after_payment_and_activity(
    database: FakeDatabase,
) -> None:
    now = datetime(2026, 9, 28, tzinfo=UTC)

    await B2BSignalService.emit_event(
        database,
        user_id="user-1",
        event_type="payment_succeeded",
        source_id="sub-1",
        occurred_at=now,
    )
    assert database["b2b_signal_actions"].docs == []

    await B2BSignalService.emit_event(
        database,
        user_id="user-1",
        event_type="flow_task_started",
        source_id="task-1",
        occurred_at=now,
    )

    assert len(database["b2b_signal_events"].docs) == 2
    assert len(database["b2b_signal_actions"].docs) == 1
    assert database["b2b_signal_actions"].docs[0]["status"] == "pending"


@pytest.mark.asyncio
async def test_pending_and_shown_endpoints_are_scoped_to_current_user(
    database: FakeDatabase,
) -> None:
    now = datetime(2026, 9, 28, tzinfo=UTC)
    await B2BSignalService.emit_event(
        database,
        user_id="user-1",
        event_type="payment_succeeded",
        source_id="sub-1",
        occurred_at=now,
    )
    await B2BSignalService.emit_event(
        database,
        user_id="user-1",
        event_type="credits_deducted",
        source_id="usage-1",
        occurred_at=now,
    )
    await B2BSignalService.emit_event(
        database,
        user_id="user-2",
        event_type="payment_succeeded",
        source_id="sub-2",
        occurred_at=now,
    )
    await B2BSignalService.emit_event(
        database,
        user_id="user-2",
        event_type="flow_task_started",
        source_id="task-2",
        occurred_at=now,
    )

    client = _client(database)
    response = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-1"))

    assert response.status_code == 200
    data = response.json()["data"]
    assert len(data) == 1
    assert data[0]["user_id"] == "user-1"

    shown = client.post(
        "/api/v2/b2b-signal/shown",
        headers=_auth("user-1"),
        json={"action_id": data[0]["action_id"]},
    )
    assert shown.status_code == 200

    after = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-1"))
    assert after.json()["data"] == []


@pytest.mark.asyncio
async def test_b2b_feishu_notification_is_not_sent_twice_after_success(
    database: FakeDatabase,
) -> None:
    feishu = FakeFeishuClient()
    action = _action()

    first = await B2BSignalService._notify_signal_if_needed(
        database,
        action=action,
        trigger_event_id="event-1",
        feishu_client=feishu,
    )
    second = await B2BSignalService._notify_signal_if_needed(
        database,
        action=action,
        trigger_event_id="event-2",
        feishu_client=feishu,
    )

    assert first is True
    assert second is False
    assert len(feishu.sent_actions) == 1
    assert database["b2b_signal_notifications"].docs[0]["status"] == "sent"


@pytest.mark.asyncio
async def test_b2b_feishu_notification_failed_status_can_retry(
    database: FakeDatabase,
) -> None:
    action = _action()
    failed_feishu = FakeFeishuClient(fail=True)
    ok_feishu = FakeFeishuClient()

    failed = await B2BSignalService._notify_signal_if_needed(
        database,
        action=action,
        trigger_event_id="event-1",
        feishu_client=failed_feishu,
    )
    retried = await B2BSignalService._notify_signal_if_needed(
        database,
        action=action,
        trigger_event_id="event-2",
        feishu_client=ok_feishu,
    )

    notification = database["b2b_signal_notifications"].docs[0]
    assert failed is False
    assert retried is True
    assert len(failed_feishu.sent_actions) == 1
    assert len(ok_feishu.sent_actions) == 1
    assert notification["status"] == "sent"
    assert "error" not in notification


@pytest.mark.asyncio
async def test_b2b_feishu_notification_sending_status_blocks_parallel_send(
    database: FakeDatabase,
) -> None:
    database["b2b_signal_notifications"].docs.append(
        {
            "_id": "user-1:b2b_upgrade_consultation",
            "notification_id": "user-1:b2b_upgrade_consultation",
            "user_id": "user-1",
            "action_id": "b2b_upgrade_consultation",
            "status": "sending",
            "created_at": datetime(2026, 9, 28, tzinfo=UTC),
        }
    )
    feishu = FakeFeishuClient()

    result = await B2BSignalService._notify_signal_if_needed(
        database,
        action=_action(),
        trigger_event_id="event-1",
        feishu_client=feishu,
    )

    assert result is False
    assert feishu.sent_actions == []
