import time
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def _get_nested(document: dict, key: str):
    current = document
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _matches(document: dict, query: dict) -> bool:
    for key, value in query.items():
        if _get_nested(document, key) != value:
            return False
    return True


def _project(document: dict, projection: dict | None) -> dict:
    result = dict(document)
    if not projection:
        return result
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


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
            for key, value in update.get("$set", {}).items():
                document[key] = value
            matched += 1
        return SimpleNamespace(matched_count=matched, modified_count=matched)

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "flow_projects": FakeCollection(),
            "shares": FakeCollection(),
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


def _client(database: FakeDatabase, monkeypatch) -> TestClient:
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _token(sub: str = "user_abc", email: str | None = "owner@example.com") -> str:
    payload = {"sub": sub, "exp": int(time.time()) + 60}
    if email is not None:
        payload["email"] = email
    encoded = jwt.encode(payload, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str = "user_abc", email: str | None = "owner@example.com") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub, email)}"}


def _create_project(client: TestClient) -> str:
    response = client.post(
        "/api/v2/flow/project",
        headers=_auth(),
        json={
            "project_name": "Shared Flow",
            "nodes": [{"id": "node-original", "data": {"status": "done"}}],
            "edges": [{"id": "edge-1", "source": "node-original", "target": "node-original"}],
            "allow_reshare": False,
        },
    )
    assert response.status_code == 201
    return response.json()["data"]["flow_id"]


def test_create_share_is_owner_scoped_and_public_info_keeps_snapshot(
    monkeypatch,
) -> None:
    database = FakeDatabase()
    client = _client(database, monkeypatch)
    flow_id = _create_project(client)

    foreign = client.post(
        "/api/v3/share",
        headers=_auth("user_other", "other@example.com"),
        json={"flow_id": flow_id},
    )
    assert foreign.status_code == 404
    assert foreign.json()["msg"] == "Flow project not found"

    created = client.post(
        "/api/v3/share",
        headers=_auth(),
        json={"flow_id": flow_id, "share_type": "workflow"},
    )
    assert created.status_code == 201
    data = created.json()["data"]
    share_id = data["share_id"]
    assert data["need_auth"] is False
    assert data["snapshot"]["nodes"][0]["id"] == "node-original"
    assert data["snapshot"]["allow_reshare"] is False

    database["flow_projects"].docs[0]["nodes"][0]["id"] = "node-mutated"

    info = client.get(f"/api/v3/share/{share_id}/info")
    assert info.status_code == 200
    assert info.json()["data"]["snapshot"]["nodes"][0]["id"] == "node-original"


def test_whitelist_info_requires_visit_and_matches_email(monkeypatch) -> None:
    database = FakeDatabase()
    client = _client(database, monkeypatch)
    flow_id = _create_project(client)

    created = client.post(
        "/api/v3/share",
        headers=_auth(),
        json={
            "flow_id": flow_id,
            "email_whitelist": ["Visitor@Example.com"],
            "share_type": "collaborative",
        },
    )
    assert created.status_code == 201
    share_id = created.json()["data"]["share_id"]
    stored = database["shares"].docs[0]
    assert stored["email_whitelist"] == ["visitor@example.com", "owner@example.com"]

    info = client.get(f"/api/v3/share/{share_id}/info")
    assert info.status_code == 200
    assert info.json()["data"]["need_auth"] is True
    assert info.json()["data"]["snapshot"] is None

    missing_auth = client.post(f"/api/v3/share/{share_id}/visit")
    assert missing_auth.status_code == 401

    denied = client.post(
        f"/api/v3/share/{share_id}/visit",
        headers=_auth("user_other", "stranger@example.com"),
    )
    assert denied.status_code == 403
    assert denied.json()["msg"] == "Email is not allowed to visit this share"

    allowed = client.post(
        f"/api/v3/share/{share_id}/visit",
        headers=_auth("user_visitor", "visitor@example.com"),
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["snapshot"]["flow_id"] == flow_id

    v2_allowed = client.post(
        "/api/v2/share/visit",
        headers=_auth("user_visitor", "visitor@example.com"),
        json={"share_id": share_id},
    )
    assert v2_allowed.status_code == 200
    assert v2_allowed.json()["data"]["snapshot"]["project_name"] == "Shared Flow"
