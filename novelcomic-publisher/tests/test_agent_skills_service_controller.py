from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.dao.agent_skills import AgentSkillsDao
from app.main import create_app
from app.schemas.agent_skills import (
    MAX_FILE_BYTES,
    CreateAgentSkillRequest,
    GenerateAgentSkillDraftRequest,
    UpdateAgentSkillRequest,
)
from app.services.agent_skill_media import draft_from_request
from app.services.agent_skills import AgentSkillsService


class FakeCursor:
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        self.documents = documents

    def __aiter__(self) -> FakeCursor:
        return self

    async def __anext__(self) -> dict[str, Any]:
        if not self.documents:
            raise StopAsyncIteration
        return self.documents.pop(0)


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        return all(document.get(key) == expected for key, expected in query.items())

    def find(self, query: dict[str, Any]) -> FakeCursor:
        return FakeCursor([deepcopy(doc) for doc in self.docs if self._matches(doc, query)])

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def insert_one(self, document: dict[str, Any]) -> SimpleNamespace:
        self.docs.append(deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("_id"))

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        for document in self.docs:
            if self._matches(document, query):
                document.update(deepcopy(update.get("$set", {})))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


def _create_request(**overrides: Any) -> CreateAgentSkillRequest:
    payload = {
        "title": "Scene Writer",
        "description": "Writes reusable scene prompts",
        "original_prompt": "Create a four-panel comic scene.",
        "scenes": ["comic"],
        "ai_tags": ["story"],
        "source_type": "prompt",
    }
    payload.update(overrides)
    return CreateAgentSkillRequest(**payload)


def _auth_headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {user_id}"}


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = SimpleNamespace(mongo={"novelcomic": database})
    return TestClient(app)


def test_file_draft_rejects_empty_file_text_in_schema() -> None:
    with pytest.raises(ValidationError):
        GenerateAgentSkillDraftRequest(
            source_type="file",
            file_name="skill.md",
            file_text="   ",
        )


def test_file_draft_rejects_unsupported_type_and_oversized_text() -> None:
    unsupported = GenerateAgentSkillDraftRequest(
        source_type="file",
        file_name="skill.pdf",
        file_text="content",
    )
    with pytest.raises(HTTPException) as unsupported_error:
        draft_from_request(unsupported)
    assert unsupported_error.value.status_code == 400
    assert unsupported_error.value.detail["code"] == "UNSUPPORTED_FILE_TYPE"

    oversized = GenerateAgentSkillDraftRequest(
        source_type="file",
        file_name="skill.md",
        file_text="x" * (MAX_FILE_BYTES + 1),
    )
    with pytest.raises(HTTPException) as oversized_error:
        draft_from_request(oversized)
    assert oversized_error.value.status_code == 413
    assert oversized_error.value.detail["code"] == "FILE_TOO_LARGE"


@pytest.mark.asyncio
async def test_generate_draft_does_not_persist_user_data() -> None:
    database = FakeDatabase()
    request = GenerateAgentSkillDraftRequest(
        source_type="prompt",
        original_prompt="Short hook. Strong ending.",
    )

    draft = await AgentSkillsService.generate_draft(request)

    assert draft["source_type"] == "prompt"
    assert draft["title"] == "Short hook. Strong ending."
    assert database["agent_skills"].docs == []


@pytest.mark.asyncio
async def test_service_validates_owned_asset_urls_and_updates_by_user() -> None:
    database = FakeDatabase()
    await database["user_assets"].insert_one({"user_id": "user-a", "url": "https://cdn/a.png"})

    created = await AgentSkillsService.create_personal(
        database,
        "user-a",
        _create_request(cover_url="https://cdn/a.png"),
    )
    assert created.cover_url == "https://cdn/a.png"

    with pytest.raises(HTTPException) as asset_error:
        await AgentSkillsService.create_personal(
            database,
            "user-b",
            _create_request(cover_url="https://cdn/a.png"),
        )
    assert asset_error.value.status_code == 404
    assert asset_error.value.detail["code"] == "ASSET_NOT_FOUND"

    with pytest.raises(HTTPException) as not_found_error:
        await AgentSkillsService.update_personal(
            database,
            "user-b",
            created.skill_id,
            UpdateAgentSkillRequest(title="Other"),
        )
    assert not_found_error.value.status_code == 404
    assert not_found_error.value.detail["code"] == "SKILL_NOT_FOUND"


def test_agent_skills_controller_requires_authentication() -> None:
    client = _client(FakeDatabase())

    response = client.get("/api/v3/agent-skills/personal")

    assert response.status_code == 401


def test_agent_skills_controller_crud_is_scoped_to_authenticated_user() -> None:
    database = FakeDatabase()
    client = _client(database)

    async def payload_for_token(token: str) -> dict[str, str]:
        return {"sub": token, "email": f"{token}@example.com"}

    with patch(
        "app.middleware.auth_middleware.JwtService.get_payload_with_backoff",
        new=AsyncMock(side_effect=payload_for_token),
    ), patch("app.controller.v3.agent_skills.get_settings") as get_settings:
        get_settings.return_value = SimpleNamespace(mongo_database="novelcomic")

        draft_response = client.post(
            "/api/v3/agent-skills/generate-draft",
            headers=_auth_headers("user-a"),
            json={"source_type": "prompt", "original_prompt": "Opening hook. Conversion scene."},
        )
        assert draft_response.status_code == 200
        assert draft_response.json()["data"]["source_type"] == "prompt"
        assert database["agent_skills"].docs == []

        create_response = client.post(
            "/api/v3/agent-skills",
            headers=_auth_headers("user-a"),
            json={
                "title": "Hook Writer",
                "description": "Creates hooks",
                "original_prompt": "Write a hook.",
                "scenes": ["ads"],
                "ai_tags": ["hook"],
                "source_type": "prompt",
            },
        )
        assert create_response.status_code == 201
        skill_id = create_response.json()["data"]["skill_id"]

        list_response = client.get(
            "/api/v3/agent-skills/personal",
            headers=_auth_headers("user-a"),
        )
        assert list_response.status_code == 200
        assert list_response.json()["data"]["total"] == 1

        cross_user_delete = client.delete(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers=_auth_headers("user-b"),
        )
        assert cross_user_delete.status_code == 404

        update_response = client.patch(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers=_auth_headers("user-a"),
            json={"title": "Updated Hook Writer"},
        )
        assert update_response.status_code == 200
        assert update_response.json()["data"]["title"] == "Updated Hook Writer"

        delete_response = client.delete(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers=_auth_headers("user-a"),
        )
        assert delete_response.status_code == 200
        assert delete_response.json()["data"]["deleted"] is True

    assert await_deleted(database, "user-a", skill_id)


def await_deleted(database: FakeDatabase, user_id: str, skill_id: str) -> bool:
    collection = database[AgentSkillsDao.collection_name]
    return any(
        document.get("user_id") == user_id
        and document.get("skill_id") == skill_id
        and document.get("status") == "deleted"
        for document in collection.docs
    )
