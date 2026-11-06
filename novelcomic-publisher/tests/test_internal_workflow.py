"""内部编辑接口：密钥通过后，只按请求体里的 user_id 更新项目。"""

import base64

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from tests.test_flow_project_assets import FakeConnections, FakeDatabase


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": base64.b64encode(key.encode("utf-8")).decode("ascii")}


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    monkeypatch.setattr(get_settings(), "mongo_database", "novelcomic")
    monkeypatch.setattr(get_settings(), "internal_api_key", "internal-secret")
    return FakeDatabase()


def test_internal_edit_uses_the_body_user_id_after_the_service_key(database: FakeDatabase) -> None:
    database["flow_projects"].docs.append(
        {
            "flow_id": "flow-b",
            "user_id": "user-b",
            "nodes": [{"id": "original"}],
            "edges": [],
            "details": {},
        }
    )
    client = _client(database)
    body = {
        "user_id": "user-b",
        "flow_id": "flow-b",
        "nodes": [{"id": "edited"}],
        "edges": [],
    }

    missing = client.post("/api/internal/workflow/edit", json=body)
    jwt = client.post(
        "/api/internal/workflow/edit",
        headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"},
        json={**body, "user_id": "user-a"},
    )

    assert missing.status_code == 401
    assert jwt.status_code == 401
    assert database["flow_projects"].docs[0]["nodes"] == [{"id": "original"}]

    edited = client.post(
        "/api/internal/workflow/edit",
        headers=_headers("internal-secret"),
        json=body,
    )
    assert edited.status_code == 200
    assert edited.json()["data"]["flow_id"] == "flow-b"
    assert database["flow_projects"].docs[0]["nodes"] == [{"id": "edited"}]
    assert database["flow_projects"].docs[0]["user_id"] == "user-b"


def test_internal_edit_does_not_update_another_users_project(database: FakeDatabase) -> None:
    database["flow_projects"].docs.append(
        {
            "flow_id": "flow-b",
            "user_id": "user-b",
            "nodes": [{"id": "original"}],
            "edges": [],
            "details": {},
        }
    )
    response = _client(database).post(
        "/api/internal/workflow/edit",
        headers=_headers("internal-secret"),
        json={
            "user_id": "user-a",
            "flow_id": "flow-b",
            "nodes": [{"id": "stolen"}],
            "edges": [],
        },
    )

    assert response.status_code == 200
    assert database["flow_projects"].docs[0]["nodes"] == [{"id": "original"}]
    assert database["flow_projects"].docs[0]["user_id"] == "user-b"


def test_internal_edit_rejects_a_user_jwt_and_an_unconfigured_key(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(database)
    monkeypatch.setattr(get_settings(), "internal_api_key", "")
    unconfigured = client.post(
        "/api/internal/workflow/edit",
        headers=_headers("internal-secret"),
        json={"user_id": "user-b", "flow_id": "flow-b", "nodes": [], "edges": []},
    )
    assert unconfigured.status_code == 503
    assert unconfigured.json()["msg"] == "internal API is not configured"
