"""Personal Agent Skill assets. They are not installed into the runtime skill loader."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.dao.agent_skills import AgentSkillsDao
from app.schemas.agent_skills import (
    AgentSkillItem,
    AgentSkillListResponse,
    CreateAgentSkillRequest,
    GenerateAgentSkillDraftRequest,
    UpdateAgentSkillRequest,
)
from app.services.agent_skill_media import draft_from_request


class AgentSkillsService:
    @staticmethod
    async def list_personal(
        database: Any,
        user_id: str,
        *,
        page: int = 1,
        page_size: int = 20,
        query_text: str | None = None,
    ) -> AgentSkillListResponse:
        skills, total = await AgentSkillsDao.list_personal(
            database,
            user_id,
            page=page,
            page_size=page_size,
            query_text=query_text,
        )
        items = [AgentSkillItem.model_validate(skill) for skill in skills]
        return AgentSkillListResponse(skills=items, total=total)

    @staticmethod
    async def generate_draft(request: GenerateAgentSkillDraftRequest) -> dict[str, Any]:
        return draft_from_request(request).model_dump(mode="json")

    @classmethod
    async def create_personal(
        cls,
        database: Any,
        user_id: str,
        request: CreateAgentSkillRequest,
    ) -> AgentSkillItem:
        await _require_owned_urls(database, user_id, request.cover_url, request.video_url)
        payload = request.model_dump(mode="json")
        created = await AgentSkillsDao.create_personal(database, user_id, payload)
        return AgentSkillItem.model_validate(created)

    @classmethod
    async def update_personal(
        cls,
        database: Any,
        user_id: str,
        skill_id: str,
        request: UpdateAgentSkillRequest,
    ) -> AgentSkillItem:
        updates = request.model_dump(exclude_none=True, mode="json")
        await _require_owned_urls(
            database,
            user_id,
            updates.get("cover_url"),
            updates.get("video_url"),
        )
        updated = await AgentSkillsDao.update_personal(database, user_id, skill_id, updates)
        if updated is None:
            raise HTTPException(status_code=404, detail={"code": "SKILL_NOT_FOUND"})
        return AgentSkillItem.model_validate(updated)

    @staticmethod
    async def delete_personal(database: Any, user_id: str, skill_id: str) -> None:
        deleted = await AgentSkillsDao.delete_personal(database, user_id, skill_id)
        if not deleted:
            raise HTTPException(status_code=404, detail={"code": "SKILL_NOT_FOUND"})


async def _require_owned_urls(
    database: Any,
    user_id: str,
    cover_url: str | None,
    video_url: str | None,
) -> None:
    for url in (cover_url, video_url):
        if not url:
            continue
        owned = await database["user_assets"].find_one({"user_id": user_id, "url": url})
        if not owned:
            raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND"})
