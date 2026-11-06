from typing import Any

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.schemas.agent_catalog import AgentCatalogHook, AgentCatalogRole


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    return all(document.get(key) == value for key, value in query.items())


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
        self.docs = docs

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        return self.docs[:length] if length is not None else self.docs


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        return FakeCursor(
            [_project(document, projection) for document in self.docs if _matches(document, query)]
        )


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {"agent_catalog": FakeCollection()}

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
    monkeypatch.setattr(get_settings(), "mongo_database", "novelcomic")
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def test_agent_catalog_entities_default_to_draft() -> None:
    hook = AgentCatalogHook(hook_id="hook-1", hook_type="director_seeds")
    role = AgentCatalogRole(role_id="role-1")

    assert hook.status == "draft"
    assert hook.kind == "hook"
    assert role.status == "draft"
    assert role.kind == "role"


def test_public_hooks_filter_published_type_and_excluded_ids(monkeypatch) -> None:
    database = FakeDatabase()
    database["agent_catalog"].docs.extend(
        [
            {
                "kind": "hook",
                "hook_id": "director-1",
                "hook_type": "director_seeds",
                "title": {"en": "Director 1"},
                "description": {},
                "status": "published",
                "sort_order": 1,
            },
            {
                "kind": "hook",
                "hook_id": "director-2",
                "hook_type": "director_seeds",
                "title": {"en": "Director 2"},
                "description": {},
                "status": "published",
                "sort_order": 2,
            },
            {
                "kind": "hook",
                "hook_id": "viral-1",
                "hook_type": "viral_hooks",
                "title": {"en": "Viral 1"},
                "description": {},
                "status": "published",
            },
            {
                "kind": "hook",
                "hook_id": "draft-1",
                "hook_type": "director_seeds",
                "title": {"en": "Draft"},
                "description": {},
                "status": "draft",
            },
        ]
    )

    response = _client(database, monkeypatch).get(
        "/api/v3/agent-catalog/hooks?hook_type=director_seeds&exclude_ids=director-2"
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == 1
    assert [item["hook_id"] for item in data["items"]] == ["director-1"]


def test_public_roles_only_return_published_roles(monkeypatch) -> None:
    database = FakeDatabase()
    database["agent_catalog"].docs.extend(
        [
            {
                "kind": "role",
                "role_id": "role-1",
                "title": {"en": "Role 1"},
                "description": {},
                "status": "published",
            },
            {
                "kind": "role",
                "role_id": "role-draft",
                "title": {"en": "Draft"},
                "description": {},
                "status": "draft",
            },
            {
                "kind": "hook",
                "hook_id": "hook-1",
                "hook_type": "viral_hooks",
                "title": {"en": "Hook"},
                "description": {},
                "status": "published",
            },
        ]
    )

    response = _client(database, monkeypatch).get("/api/v3/agent-catalog/roles")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["role_id"] == "role-1"
