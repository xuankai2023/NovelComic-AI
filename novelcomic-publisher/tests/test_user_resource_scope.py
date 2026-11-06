"""用户 JWT 只能读到自己的 flow、run 和结果。请求体里的 user_id 不进查询。"""

import time
from datetime import UTC, datetime

import jwt
import pytest

from app.config import get_settings
from app.dao.flow import FlowDao
from tests.test_flow_project_assets import _PRIVATE_KEY, _PUBLIC_PEM, FakeDatabase, _auth, _client


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    store = FakeDatabase()
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    return store


async def test_owner_query_misses_another_users_project_while_share_lookup_finds_it(
    database: FakeDatabase,
) -> None:
    database["flow_projects"].docs.append(
        {"flow_id": "flow-b", "user_id": "user_b", "nodes": [{"id": "node-b"}]}
    )

    owner_project = await FlowDao.get_workflow_project(database, "flow-b", "user_a")
    share_project = await FlowDao.get_workflow_project_by_flow_id(database, "flow-b")
    assert owner_project is None
    assert share_project is not None
    assert share_project["user_id"] == "user_b"
    assert share_project["nodes"] == [{"id": "node-b"}]


def test_run_read_for_another_user_matches_a_missing_run(database: FakeDatabase) -> None:
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-b",
            "flow_run_id": "run-b",
            "flow_id": "flow-b",
            "status": "running",
            "trace_id": "trace-b",
            "user_id": "user_b",
            "created_at": datetime.now(UTC),
        }
    )
    client = _client(database)

    missing = client.get("/api/v2/flow/runs/task-missing", headers=_auth("user_a"))
    foreign = client.get("/api/v2/flow/runs/task-b", headers=_auth("user_a"))
    owned = client.get("/api/v2/flow/runs/task-b", headers=_auth("user_b"))

    assert missing.status_code == 404
    assert missing.json()["msg"] == "Workflow run not found"
    assert foreign.status_code == missing.status_code
    assert foreign.json() == missing.json()
    assert owned.status_code == 200
    assert owned.json()["data"]["flow_task_id"] == "task-b"

    listed = client.get("/api/v2/flow/runs", headers=_auth("user_a"), params={"flow_id": "flow-b"})
    assert listed.status_code == 200
    assert listed.json()["data"] == []


def test_create_run_ignores_a_body_user_id(database: FakeDatabase) -> None:
    client = _client(database)
    response = client.post(
        "/api/v2/flow/runs",
        headers=_auth("user_a"),
        json={
            "client_request_id": "req-1",
            "flow_id": "flow-1",
            "flow_task": {"nodes": [{"id": "n"}], "edges": []},
            "user_id": "user_b",
        },
    )

    assert response.status_code == 422
    assert database["flow_task"].docs == []


def test_result_query_uses_the_jwt_subject_not_the_body_user_id(database: FakeDatabase) -> None:
    now = datetime.now(UTC)
    database["node_results"].docs.append(
        {
            "workflow_id": "flow-b",
            "node_id": "node-1",
            "result_id": "result-1",
            "user_id": "user_b",
            "result": "secret",
            "created_at": now,
        }
    )
    client = _client(database)
    body = {
        "workflow_id": "flow-b",
        "node_ids": ["node-1"],
        "user_id": "user_b",
    }

    foreign = client.post("/api/v3/result/all_batch_fetch", headers=_auth("user_a"), json=body)
    missing = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth("user_a"),
        json={"workflow_id": "flow-missing", "node_ids": ["node-1"], "user_id": "user_b"},
    )
    owned = client.post("/api/v3/result/all_batch_fetch", headers=_auth("user_b"), json=body)

    assert foreign.status_code == 200
    assert foreign.json()["data"] == {"node-1": []}
    assert missing.json()["data"] == foreign.json()["data"]
    assert owned.status_code == 200
    assert owned.json()["data"]["node-1"][0]["result"] == "secret"
    assert "user_id" not in owned.json()["data"]["node-1"][0]


def test_result_update_does_not_follow_a_body_user_id(database: FakeDatabase) -> None:
    database["node_results"].docs.append(
        {
            "workflow_id": "flow-b",
            "node_id": "node-1",
            "result_id": "result-1",
            "user_id": "user_b",
            "result": "secret",
        }
    )
    client = _client(database)
    foreign = client.patch(
        "/api/v3/result",
        headers=_auth("user_a"),
        json={
            "flow_id": "flow-b",
            "node_id": "node-1",
            "result_id": "result-1",
            "result": "changed",
            "user_id": "user_b",
        },
    )

    assert foreign.status_code == 404
    assert foreign.json()["msg"] == "Result not found"
    assert database["node_results"].docs[0]["result"] == "secret"

    owned = client.patch(
        "/api/v3/result",
        headers=_auth("user_b"),
        json={
            "flow_id": "flow-b",
            "node_id": "node-1",
            "result_id": "result-1",
            "result": "edited",
            "user_id": "user_a",
        },
    )
    assert owned.status_code == 200
    assert database["node_results"].docs[0]["result"] == "edited"
    assert database["node_results"].docs[0]["user_id"] == "user_b"


def _auth_with_email(sub: str, email: str) -> dict[str, str]:
    encoded = jwt.encode(
        {"sub": sub, "email": email, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    token = encoded if isinstance(encoded, str) else encoded.decode()
    return {"Authorization": f"Bearer {token}"}


def test_shared_result_query_uses_the_owner_and_rejects_bad_shares(database: FakeDatabase) -> None:
    now = datetime.now(UTC)
    database["node_results"].docs.extend(
        [
            {
                "workflow_id": "flow-b",
                "node_id": "node-1",
                "result_id": "result-1",
                "user_id": "user_b",
                "result": "secret",
                "created_at": now,
            },
            {
                "workflow_id": "flow-other",
                "node_id": "node-1",
                "result_id": "result-other",
                "user_id": "user_b",
                "result": "other-flow",
                "created_at": now,
            },
        ]
    )
    database["shares"].docs.extend(
        [
            {
                "share_id": "share-public",
                "flow_id": "flow-b",
                "owner_user_id": "user_b",
                "email_whitelist": [],
            },
            {
                "share_id": "share-private",
                "flow_id": "flow-b",
                "owner_user_id": "user_b",
                "email_whitelist": ["owner@example.com"],
            },
        ]
    )
    client = _client(database)
    public_body = {
        "workflow_id": "flow-b",
        "node_ids": ["node-1"],
        "share_id": "share-public",
        "user_id": "user_c",
    }

    shared = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth("user_a"),
        json=public_body,
    )
    mismatched = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth("user_a"),
        json={**public_body, "workflow_id": "flow-other"},
    )
    missing = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth("user_a"),
        json={**public_body, "share_id": "share-missing"},
    )
    denied = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth_with_email("user_a", "Stranger@Example.com"),
        json={**public_body, "share_id": "share-private"},
    )
    allowed = client.post(
        "/api/v3/result/all_batch_fetch",
        headers=_auth_with_email("user_a", "Owner@Example.com"),
        json={**public_body, "share_id": "share-private"},
    )

    assert shared.status_code == 200
    assert shared.json()["data"]["node-1"][0]["result"] == "secret"
    assert mismatched.status_code == 200
    assert mismatched.json()["data"] == {"node-1": []}
    assert missing.status_code == 404
    assert missing.json()["code"] == 1040
    assert denied.status_code == 403
    assert denied.json()["code"] == 1041
    assert allowed.status_code == 200
    assert allowed.json()["data"]["node-1"][0]["result"] == "secret"


def test_unauthenticated_result_request_is_rejected(database: FakeDatabase) -> None:
    client = _client(database)
    response = client.post(
        "/api/v3/result/all_batch_fetch",
        json={"workflow_id": "flow-1", "node_ids": ["node-1"]},
    )
    assert response.status_code == 401
    assert response.json()["msg"] == "Authorization field is required"
