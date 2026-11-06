from __future__ import annotations

import base64
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_workflow_dag_execution import FakeConnections, FakeDatabase

from app.config import get_settings
from app.controller.internal import register_internal_api
from app.database.mongo import FLOW_EVENT_OUTBOX, FLOW_NODE_STATE, FLOW_RUN_STATE, FLOW_TASK
from app.main import create_app

SNAPSHOT_PATH = "/api/internal/workflow/task-1/snapshot"


@pytest.fixture
def internal_key() -> Iterator[str]:
    settings = get_settings()
    previous = settings.internal_api_key
    settings.internal_api_key = "internal-secret"
    try:
        yield "internal-secret"
    finally:
        settings.internal_api_key = previous


def _authorization(key: str) -> dict[str, str]:
    encoded = base64.b64encode(key.encode("utf-8")).decode("ascii")
    return {"Authorization": encoded}


def _client(database: FakeDatabase) -> TestClient:
    app = FastAPI()
    register_internal_api(app)
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _seed_run(database: FakeDatabase) -> None:
    database[FLOW_TASK].docs["task-1"] = {
        "_id": "task-1",
        "flow_task_id": "task-1",
        "status": "queued",
    }
    database[FLOW_RUN_STATE].docs["run-1"] = {
        "_id": "run-1",
        "flow_run_id": "run-1",
        "flow_task_id": "task-1",
        "run_id": "run-1",
        "status": "running",
        "updated_at": datetime(2026, 9, 30, 8, 0, tzinfo=UTC),
    }
    database[FLOW_NODE_STATE].docs["run-1:model"] = {
        "_id": "run-1:model",
        "node_id": "model",
        "run_id": "run-1",
        "status": "running",
    }
    database[FLOW_EVENT_OUTBOX].docs["evt-1"] = {
        "_id": "evt-1",
        "created_at": datetime(2026, 9, 30, 8, 5, tzinfo=UTC),
        "event_id": "evt-1",
        "flow_task_id": "task-1",
        "status": "sent",
    }


def test_snapshot_route_is_registered_once() -> None:
    app = create_app()
    paths = list(app.openapi()["paths"])
    assert paths.count("/api/internal/workflow/{flow_task_id}/snapshot") == 1
    assert not any("/internal/internal/" in path for path in paths)


def test_missing_internal_key_returns_503() -> None:
    settings = get_settings()
    previous = settings.internal_api_key
    settings.internal_api_key = ""
    try:
        response = _client(FakeDatabase()).get(
            SNAPSHOT_PATH,
            headers=_authorization("internal-secret"),
        )
    finally:
        settings.internal_api_key = previous

    assert response.status_code == 503
    assert response.json()["detail"] == "internal API is not configured"


def test_bad_internal_credentials_return_401(internal_key: str) -> None:
    client = _client(FakeDatabase())
    missing = client.get(SNAPSHOT_PATH)
    invalid = client.get(SNAPSHOT_PATH, headers={"Authorization": "not-base64"})
    bearer = client.get(
        SNAPSHOT_PATH,
        headers={"Authorization": f"Bearer {_authorization(internal_key)['Authorization']}"},
    )
    user_jwt = client.get(
        SNAPSHOT_PATH,
        headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"},
    )
    wrong = client.get(SNAPSHOT_PATH, headers=_authorization("wrong-secret"))

    assert missing.status_code == 401
    assert missing.json()["detail"] == "missing authorization value for internal endpoint"
    assert invalid.status_code == 401
    assert bearer.status_code == 401
    assert user_jwt.status_code == 401
    assert wrong.status_code == 401
    assert wrong.json()["detail"] == "invalid authorization value for internal endpoint"


def test_unknown_flow_task_returns_404_and_existing_run_returns_protocol_v2(
    internal_key: str,
) -> None:
    database = FakeDatabase()
    client = _client(database)
    headers = _authorization(internal_key)

    missing = client.get(SNAPSHOT_PATH, headers=headers)
    _seed_run(database)
    found = client.get(SNAPSHOT_PATH, headers=headers)
    rejected = client.get(SNAPSHOT_PATH, headers=_authorization("wrong-secret"))

    assert missing.status_code == 404
    assert missing.json() == {"detail": "workflow snapshot not found"}
    assert found.status_code == 200
    body = found.json()
    assert body["protocol_version"] == 2
    assert body["flow_task_id"] == "task-1"
    assert body["flow_run_id"] == "run-1"
    assert body["status"] == "running"
    assert body["last_event_id"] == "evt-1"
    assert body["flow_node_state"][0]["node_id"] == "model"
    assert rejected.status_code == 401
