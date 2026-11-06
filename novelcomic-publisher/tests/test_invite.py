import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services.invite import InviteService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"novelcomic-invite-test").decode()


def _matches(document: dict, query: dict) -> bool:
    return all(document.get(key) == value for key, value in query.items())


class FakeCursor:
    def __init__(self, docs: list[dict]) -> None:
        self.docs = [dict(doc) for doc in docs]

    def sort(self, key: str, direction: int):
        reverse = direction < 0
        self.docs.sort(key=lambda item: item.get(key), reverse=reverse)
        return self

    def skip(self, count: int):
        self.docs = self.docs[count:]
        return self

    def limit(self, count: int):
        self.docs = self.docs[:count]
        return self

    async def to_list(self, length: int | None = None) -> list[dict]:
        return [dict(doc) for doc in self.docs]


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict] = []

    async def insert_one(self, document: dict) -> None:
        self.docs.append(dict(document))

    async def update_one(self, query: dict, update: dict) -> SimpleNamespace:
        matched = 0
        for document in self.docs:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            matched += 1
        return SimpleNamespace(matched_count=matched, modified_count=matched)

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return dict(document)
        return None

    def find(self, query: dict, projection: dict | None = None) -> FakeCursor:
        return FakeCursor([doc for doc in self.docs if _matches(doc, query)])

    async def count_documents(self, query: dict) -> int:
        return sum(1 for doc in self.docs if _matches(doc, query))


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "users": FakeCollection(),
            "invite_relations": FakeCollection(),
            "invite_credit_records": FakeCollection(),
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
    monkeypatch.setattr(settings, "clerk_webhook_secret", _WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    return store


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _token(sub: str = "inviter") -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str = "inviter") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def _sign(body: bytes) -> dict[str, str]:
    message_id = "msg_invite"
    timestamp = str(int(time.time()))
    secret = base64.b64decode(_WEBHOOK_SECRET.removeprefix("whsec_"))
    signed = f"{message_id}.{timestamp}.{body.decode()}".encode()
    digest = hmac.new(secret, signed, hashlib.sha256).digest()
    return {
        "svix-id": message_id,
        "svix-timestamp": timestamp,
        "svix-signature": "v1," + base64.b64encode(digest).decode(),
    }


async def _seed_inviter(database: FakeDatabase, user_id: str = "inviter") -> str:
    code = InviteService.generate_invite_code(user_id)
    await database["users"].insert_one(
        {"user_id": user_id, "user_email": "owner@example.com", "invite_code": code}
    )
    return code


@pytest.mark.asyncio
async def test_bind_registered_user_rewards_once_and_blocks_self_invite(
    database: FakeDatabase,
) -> None:
    code = await _seed_inviter(database)
    now = datetime(2026, 9, 28, tzinfo=UTC)

    self_invite = await InviteService.bind_registered_user(
        database,
        invitee_user_id="inviter",
        invitee_email="owner@example.com",
        invite_code=code,
        now=now,
    )
    assert self_invite is None

    relation = await InviteService.bind_registered_user(
        database,
        invitee_user_id="invitee",
        invitee_email="friend@example.com",
        invite_code=code.lower(),
        now=now,
    )
    assert relation is not None
    assert relation.registration_rewarded is True
    assert len(database["invite_credit_records"].docs) == 1

    duplicate = await InviteService.bind_registered_user(
        database,
        invitee_user_id="invitee",
        invitee_email="friend@example.com",
        invite_code=code,
        now=now,
    )
    assert duplicate is not None
    assert len(database["invite_relations"].docs) == 1
    assert len(database["invite_credit_records"].docs) == 1


@pytest.mark.asyncio
async def test_register_reward_is_limited_to_ten_invitees(database: FakeDatabase) -> None:
    code = await _seed_inviter(database)
    now = datetime(2026, 9, 28, tzinfo=UTC)

    for index in range(11):
        await InviteService.bind_registered_user(
            database,
            invitee_user_id=f"invitee-{index}",
            invitee_email=f"friend-{index}@example.com",
            invite_code=code,
            now=now,
        )

    register_records = [
        doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "register"
    ]
    assert len(register_records) == 10
    assert database["invite_relations"].docs[-1]["registration_rewarded"] is False


@pytest.mark.asyncio
async def test_paid_reward_requires_bound_user_in_seven_day_window(database: FakeDatabase) -> None:
    code = await _seed_inviter(database)
    created_at = datetime(2026, 9, 1, tzinfo=UTC)
    await InviteService.bind_registered_user(
        database,
        invitee_user_id="invitee",
        invitee_email="friend@example.com",
        invite_code=code,
        now=created_at,
    )

    late = await InviteService.reward_paid_user(
        database,
        invitee_user_id="invitee",
        source_id="payment:late",
        paid_at=created_at + timedelta(days=8),
    )
    assert late is None

    paid = await InviteService.reward_paid_user(
        database,
        invitee_user_id="invitee",
        source_id="payment:ok",
        paid_at=created_at + timedelta(days=7),
    )
    assert paid is not None
    assert paid.points == 1000

    duplicate = await InviteService.reward_paid_user(
        database,
        invitee_user_id="invitee",
        source_id="payment:again",
        paid_at=created_at + timedelta(days=7),
    )
    assert duplicate is None
    paid_records = [
        doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "paid"
    ]
    assert len(paid_records) == 1


def test_user_created_webhook_binds_invite_and_user_info_returns_summary(
    database: FakeDatabase,
) -> None:
    client = _client(database)
    code = InviteService.generate_invite_code("inviter")
    database["users"].docs.append(
        {"user_id": "inviter", "user_email": "owner@example.com", "invite_code": code}
    )
    body = json.dumps(
        {
            "type": "user.created",
            "data": {
                "id": "invitee",
                "email_addresses": [{"email_address": "friend@example.com"}],
                "unsafe_metadata": {"inviteCode": code},
            },
        }
    ).encode()

    created = client.post("/api/v1/user/create", content=body, headers=_sign(body))
    assert created.status_code == 200
    assert len(database["invite_relations"].docs) == 1

    again = client.post("/api/v1/user/create", content=body, headers=_sign(body))
    assert again.status_code == 200
    assert len(database["invite_relations"].docs) == 1

    info = client.get("/api/v2/user/info", headers=_auth("inviter"))
    assert info.status_code == 200
    data = info.json()["data"]
    assert data["credits"] == 200
    summary = data["invite_summary"]
    assert summary["invited_count"] == 1
    assert summary["register_points"] == 200
    assert summary["total_points"] == 200
    assert summary["invite_link_path"] == f"/?invite={code}"

    invitees = client.get("/api/v2/user/invitees", headers=_auth("inviter"))
    assert invitees.status_code == 200
    assert invitees.json()["data"]["items"][0]["invitee_user_id"] == "invitee"

    credits = client.get("/api/v2/user/invite-credits", headers=_auth("inviter"))
    assert credits.status_code == 200
    assert credits.json()["data"]["items"][0]["points"] == 200
