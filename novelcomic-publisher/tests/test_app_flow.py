import time
from types import SimpleNamespace
from typing import Any

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


def _get_nested(document: dict[str, Any], key: str) -> Any:
    current: Any = document
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, value in query.items():
        if _get_nested(document, key) != value:
            return False
    return True


def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
    result = dict(document)
    if not projection:
        return result
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(dict(document))

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
    ) -> SimpleNamespace:
        matched = 0
        for document in self.docs:
            if not _matches(document, query):
                continue
            document.update(update.get("$set", {}))
            matched += 1
        return SimpleNamespace(matched_count=matched, modified_count=matched)

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "app_flows": FakeCollection(),
            "flow_projects": FakeCollection(),
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


def _create_project(client: TestClient, name: str = "Source Flow") -> str:
    response = client.post(
        "/api/v2/flow/project",
        headers=_auth(),
        json={
            "project_name": name,
            "nodes": [{"id": "node-original"}],
            "edges": [{"id": "edge-1", "source": "node-original", "target": "node-original"}],
        },
    )
    assert response.status_code == 201
    return response.json()["data"]["flow_id"]


def test_get_missing_app_flow_returns_null(monkeypatch) -> None:
    client = _client(FakeDatabase(), monkeypatch)

    response = client.get("/api/v3/app-flow/missing-flow", headers=_auth())

    assert response.status_code == 200
    assert response.json() == {"code": 200, "msg": "ok", "data": None}


def test_create_app_flow_syncs_current_users_workflow(monkeypatch) -> None:
    database = FakeDatabase()
    client = _client(database, monkeypatch)
    flow_id = _create_project(client)

    foreign = client.post(
        "/api/v3/app-flow",
        headers=_auth("user_other", "other@example.com"),
        json={"flow_id": flow_id, "title": "Foreign App"},
    )
    assert foreign.status_code == 404
    assert foreign.json()["msg"] == "Flow project not found"

    created = client.post(
        "/api/v3/app-flow",
        headers=_auth(),
        json={
            "flow_id": flow_id,
            "title": "Reader App",
            "description": "Read the generated comic.",
            "visible_nodes": ["node-original"],
            "app_mode_config": {"layout": "reader"},
        },
    )

    assert created.status_code == 201
    data = created.json()["data"]
    assert data["flow_id"] == flow_id
    assert data["title"] == "Reader App"
    assert data["nodes"][0]["id"] == "node-original"
    assert data["app_mode_config"] == {"layout": "reader"}

    duplicate = client.post(
        "/api/v3/app-flow",
        headers=_auth(),
        json={"flow_id": flow_id, "title": "Duplicate"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == 6001


def test_update_app_flow_can_sync_latest_workflow_nodes(monkeypatch) -> None:
    database = FakeDatabase()
    client = _client(database, monkeypatch)
    flow_id = _create_project(client)
    created = client.post(
        "/api/v3/app-flow",
        headers=_auth(),
        json={"flow_id": flow_id, "title": "Reader App"},
    )
    assert created.status_code == 201

    database["flow_projects"].docs[0]["nodes"] = [{"id": "node-latest"}]
    updated = client.patch(
        f"/api/v3/app-flow/{flow_id}",
        headers=_auth(),
        json={
            "sync_workflow": True,
            "title": "Updated App",
            "demo_image_urls": ["https://cdn.test/demo.png"],
        },
    )

    assert updated.status_code == 200
    data = updated.json()["data"]
    assert data["title"] == "Updated App"
    assert data["nodes"][0]["id"] == "node-latest"
    assert data["demo_image_urls"] == ["https://cdn.test/demo.png"]

    fetched = client.get(f"/api/v3/app-flow/{flow_id}", headers=_auth("visitor", "v@example.com"))
    assert fetched.status_code == 200
    assert fetched.json()["data"]["nodes"][0]["id"] == "node-latest"
