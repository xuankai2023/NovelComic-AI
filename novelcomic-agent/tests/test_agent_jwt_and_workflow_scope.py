from __future__ import annotations

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from novelcomic_agent.api.server import (
    _authenticate_agent_user,
    _require_owned_run,
    create_agent_router,
)
from novelcomic_agent.config import Settings
from novelcomic_agent.core.tools.run_workflow import RunWorkflowTool
from novelcomic_agent.dao.workflow_dao import WorkflowDAO
from novelcomic_agent.services.agent_redis_run_store import RedisRunStore
from novelcomic_agent.session.manager import SessionManager

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def _settings(**overrides: str) -> Settings:
    return Settings(
        clerk_pem_public_key=overrides.get("clerk_pem_public_key", _PUBLIC_PEM),
        public_chat_user_id=overrides.get("public_chat_user_id", ""),
    )


def _token(sub: str, *, expired: bool = False) -> str:
    exp = int(time.time()) + (-30 if expired else 60)
    encoded = jwt.encode({"sub": sub, "exp": exp}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _authenticate(authorization: str | None, settings: Settings, requested: str | None = None):
    return _authenticate_agent_user(
        authorization=authorization,
        requested_user_id=requested,
        settings=settings,
    )


def test_invalid_jwt_is_401() -> None:
    settings = _settings()
    with pytest.raises(HTTPException) as missing:
        _authenticate(None, settings)
    assert missing.value.status_code == 401

    with pytest.raises(HTTPException) as garbage:
        _authenticate("Bearer not-a-jwt", settings)
    assert garbage.value.status_code == 401

    with pytest.raises(HTTPException) as expired:
        _authenticate(f"Bearer {_token('user-a', expired=True)}", settings)
    assert expired.value.status_code == 401


def test_bearer_user_id_comes_from_sub() -> None:
    settings = _settings()
    user = _authenticate(
        f"Bearer {_token('user-a')}",
        settings,
        requested="user-b",
    )
    assert user.user_id == "user-a"


def test_public_chat_user_without_bearer() -> None:
    settings = _settings(public_chat_user_id="public-user")
    user = _authenticate(None, settings)
    assert user.user_id == "public-user"

    with pytest.raises(HTTPException) as other:
        _authenticate(None, settings, requested="someone-else")
    assert other.value.status_code == 403


class FakeRedis:
    def __init__(self, meta: dict[str, str]) -> None:
        self.meta = meta

    async def hgetall(self, key: str) -> dict[str, str]:
        del key
        return self.meta


def test_other_users_run_is_403() -> None:
    app = FastAPI()
    app.include_router(create_agent_router(_settings()))
    app.state.dependencies = SimpleNamespace(redis=FakeRedis({"user_id": "user-b"}))
    with TestClient(app) as client:
        response = client.post(
            "/v1/agent/runs/run-b/cancel",
            headers={"Authorization": f"Bearer {_token('user-a')}", "X-User-Id": "user-b"},
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "RUN_FORBIDDEN"


def test_other_users_session_is_403(monkeypatch: pytest.MonkeyPatch) -> None:
    async def other_session(self, session_id: str, user_id: str = "", **kwargs: object):
        del self, session_id, user_id, kwargs
        return SimpleNamespace(user_id="user-b")

    monkeypatch.setattr(SessionManager, "get_or_create", other_session)
    app = FastAPI()
    app.include_router(create_agent_router(_settings()))
    app.state.dependencies = SimpleNamespace(
        redis=FakeRedis({}),
        mongo={"novelcomic": _EmptyDatabase()},
    )
    with TestClient(app) as client:
        response = client.get(
            "/v1/agent/sessions/session-b/messages",
            headers={"Authorization": f"Bearer {_token('user-a')}"},
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "RUN_FORBIDDEN"


class _EmptyDatabase:
    def __getitem__(self, name: str) -> object:
        del name
        return object()


@pytest.mark.asyncio
async def test_owned_run_check_rejects_a_different_user() -> None:
    store = RedisRunStore(FakeRedis({"user_id": "user-b"}))
    with pytest.raises(HTTPException) as exc:
        await _require_owned_run(store, "run-b", "user-a")
    assert exc.value.status_code == 403


class RecordingFlows:
    def __init__(self) -> None:
        self.queries: list[dict[str, str]] = []
        self.docs = [{"flow_id": "flow-1", "user_id": "user-a", "nodes": [], "edges": []}]

    async def find_one(self, query: dict[str, str], projection: dict[str, int]) -> dict | None:
        del projection
        self.queries.append(query)
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return document
        return None

    async def update_one(self, query: dict[str, str], update: dict) -> None:
        self.queries.append(query)
        del update


@pytest.mark.asyncio
async def test_workflow_query_includes_authenticated_user_id() -> None:
    flows = RecordingFlows()
    dao = WorkflowDAO(flows)
    found = await dao.get_workflow("flow-1", "user-a")
    missing = await dao.get_workflow("flow-1", "user-b")
    assert found is not None
    assert found["user_id"] == "user-a"
    assert missing is None
    assert flows.queries == [
        {"flow_id": "flow-1", "user_id": "user-a"},
        {"flow_id": "flow-1", "user_id": "user-b"},
    ]


@pytest.mark.asyncio
async def test_run_workflow_requires_user_and_flow() -> None:
    flows = RecordingFlows()
    tool = RunWorkflowTool(WorkflowDAO(flows))

    missing_flow = await tool.execute({}, {"user_id": "user-a"})
    missing_user = await tool.execute({}, {"flow_id": "flow-1"})
    ready = await tool.execute({}, {"user_id": "user-a", "flow_id": "flow-1"})

    assert missing_flow.startswith("Error: no flow_id")
    assert missing_user.startswith("Error: no authenticated user")
    assert ready == "Workflow flow-1 is ready."
    assert flows.queries == [{"flow_id": "flow-1", "user_id": "user-a"}]


class _FeedbackCollection:
    def __init__(self) -> None:
        self.upserts: list[tuple[dict, dict]] = []
        self.deletes: list[dict] = []

    async def update_one(self, query: dict, update: dict, upsert: bool = False) -> None:
        del upsert
        self.upserts.append((query, update))

    async def delete_one(self, query: dict) -> None:
        self.deletes.append(query)


class _FeedbackDatabase:
    def __init__(self) -> None:
        self.feedback = _FeedbackCollection()

    def __getitem__(self, name: str) -> object:
        if name == "agent_feedback":
            return self.feedback
        return object()


def test_agent_models_and_session_feedback_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    async def owned_session(self, session_id: str, user_id: str = "", **kwargs: object):
        del self, session_id, user_id, kwargs
        return SimpleNamespace(user_id="user-a")

    monkeypatch.setattr(SessionManager, "get_or_create", owned_session)
    db = _FeedbackDatabase()
    app = FastAPI()
    app.include_router(create_agent_router(_settings()))
    app.state.dependencies = SimpleNamespace(
        redis=FakeRedis({}),
        mongo={"novelcomic": db},
    )
    headers = {"Authorization": f"Bearer {_token('user-a')}"}
    with TestClient(app) as client:
        models_res = client.get("/v1/agent/models", headers=headers)
        assert models_res.status_code == 200
        models_body = models_res.json()
        assert models_body["default_model"] == "deepseek_v4_flash"
        assert [m["id"] for m in models_body["models"]] == [
            "deepseek_v4_flash",
            "claude",
            "kimi_k3",
        ]

        fb_res = client.put(
            "/v1/agent/sessions/s-1/feedback",
            headers=headers,
            json={"turn": 1, "rating": "like", "comment": "great"},
        )
        assert fb_res.status_code == 200
        assert fb_res.json()["rating"] == "like"
        assert len(db.feedback.upserts) == 1

        del_res = client.delete(
            "/v1/agent/sessions/s-1/feedback?turn=1",
            headers=headers,
        )
        assert del_res.status_code == 200
        assert len(db.feedback.deletes) == 1

