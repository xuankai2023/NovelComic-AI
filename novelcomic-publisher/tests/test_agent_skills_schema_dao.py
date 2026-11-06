from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from app.dao.agent_skills import AgentSkillsDao
from app.schemas.agent_skills import (
    MAX_AI_TAG_COUNT,
    MAX_ORIGINAL_PROMPT_LENGTH,
    CreateAgentSkillRequest,
    GenerateAgentSkillDraftRequest,
)


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


def _payload(**overrides: Any) -> dict[str, Any]:
    request = CreateAgentSkillRequest(
        title=overrides.pop("title", "Panel Writer"),
        description=overrides.pop("description", "Writes comic panel prompts"),
        original_prompt=overrides.pop("original_prompt", "Write four panels."),
        scenes=overrides.pop("scenes", ["draft", "draft", "polish"]),
        ai_tags=overrides.pop("ai_tags", ["comic", "story"]),
        source_type=overrides.pop("source_type", "prompt"),
        **overrides,
    )
    return request.model_dump(mode="json")


def test_create_agent_skill_request_normalizes_values() -> None:
    request = CreateAgentSkillRequest(
        title="  My Skill  ",
        description="  Helpful skill  ",
        original_prompt=" keep original spacing ",
        scenes=[" Draft ", "draft", "", "Polish"],
        ai_tags=[" Tag ", "tag", "Story"],
        source_type="prompt",
    )

    assert request.title == "My Skill"
    assert request.description == "Helpful skill"
    assert request.original_prompt == " keep original spacing "
    assert request.scenes == ["Draft", "Polish"]
    assert request.ai_tags == ["Tag", "Story"]


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "   "},
        {"scenes": ["", "   "]},
        {"original_prompt": "   "},
        {"original_prompt": "x" * (MAX_ORIGINAL_PROMPT_LENGTH + 1)},
        {"ai_tags": [f"tag-{index}" for index in range(MAX_AI_TAG_COUNT + 1)]},
        {"ai_tags": ["x" * 33]},
        {"source_type": "video"},
    ],
)
def test_create_agent_skill_request_rejects_invalid_payloads(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _payload(**payload)


@pytest.mark.parametrize(
    "payload",
    [
        {"source_type": "prompt", "original_prompt": "   "},
        {"source_type": "prompt", "original_prompt": "x" * (MAX_ORIGINAL_PROMPT_LENGTH + 1)},
        {"source_type": "file", "file_name": "skill.md"},
        {"source_type": "video"},
    ],
)
def test_generate_draft_request_rejects_missing_or_invalid_source(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        GenerateAgentSkillDraftRequest(**payload)


@pytest.mark.asyncio
async def test_agent_skills_dao_isolates_personal_records_by_user() -> None:
    database = FakeDatabase()
    created = await AgentSkillsDao.create_personal(database, "user-a", _payload())
    other = await AgentSkillsDao.create_personal(database, "user-b", _payload(title="Other Skill"))

    user_a_items, user_a_total = await AgentSkillsDao.list_personal(database, "user-a")
    user_b_items, user_b_total = await AgentSkillsDao.list_personal(database, "user-b")

    assert user_a_total == 1
    assert user_b_total == 1
    assert user_a_items[0]["skill_id"] == created["skill_id"]
    assert user_b_items[0]["skill_id"] == other["skill_id"]
    assert await AgentSkillsDao.get_personal(database, "user-b", created["skill_id"]) is None

    assert (
        await AgentSkillsDao.update_personal(
            database,
            "user-b",
            created["skill_id"],
            {"title": "Hijacked"},
        )
        is None
    )
    unchanged = await AgentSkillsDao.get_personal(database, "user-a", created["skill_id"])
    assert unchanged is not None
    assert unchanged["title"] == "Panel Writer"

    assert await AgentSkillsDao.delete_personal(database, "user-b", created["skill_id"]) is False
    assert await AgentSkillsDao.get_personal(database, "user-a", created["skill_id"]) is not None

    assert await AgentSkillsDao.delete_personal(database, "user-a", created["skill_id"]) is True
    assert await AgentSkillsDao.get_personal(database, "user-a", created["skill_id"]) is None
    user_a_items_after_delete, user_a_total_after_delete = await AgentSkillsDao.list_personal(
        database,
        "user-a",
    )
    assert user_a_items_after_delete == []
    assert user_a_total_after_delete == 0


@pytest.mark.asyncio
async def test_agent_skills_dao_searches_owned_active_records() -> None:
    database = FakeDatabase()
    await AgentSkillsDao.create_personal(
        database,
        "user-a",
        _payload(title="Layout Helper", ai_tags=["composition"]),
    )
    await AgentSkillsDao.create_personal(database, "user-b", _payload(title="Composition"))

    items, total = await AgentSkillsDao.list_personal(
        database,
        "user-a",
        query_text="composition",
    )

    assert total == 1
    assert items[0]["title"] == "Layout Helper"
