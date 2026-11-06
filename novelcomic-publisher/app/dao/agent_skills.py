"""Mongo access for personal Agent Skill assets."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


class AgentSkillsDao:
    collection_name = "agent_skills"

    @classmethod
    def _owner_active_query(cls, user_id: str, skill_id: str | None = None) -> dict[str, Any]:
        query: dict[str, Any] = {"user_id": user_id, "status": "active"}
        if skill_id is not None:
            query["skill_id"] = skill_id
        return query

    @classmethod
    async def list_personal(
        cls,
        database: Any,
        user_id: str,
        *,
        page: int = 1,
        page_size: int = 20,
        query_text: str | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        matched = []
        cursor = database[cls.collection_name].find(cls._owner_active_query(user_id))
        async for document in cursor:
            if query_text and not _matches_query_text(document, query_text):
                continue
            matched.append(_public(document))
        start = max(page - 1, 0) * page_size
        return matched[start : start + page_size], len(matched)

    @classmethod
    async def get_personal(
        cls,
        database: Any,
        user_id: str,
        skill_id: str,
    ) -> dict[str, Any] | None:
        document = await database[cls.collection_name].find_one(
            cls._owner_active_query(user_id, skill_id)
        )
        return _public(document) if document else None

    @classmethod
    async def create_personal(
        cls,
        database: Any,
        user_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        document = {
            **payload,
            "skill_id": f"skill_{uuid4().hex[:16]}",
            "user_id": user_id,
            "status": "active",
            "created_at": now,
            "updated_at": now,
        }
        await database[cls.collection_name].insert_one(dict(document))
        return _public(document)

    @classmethod
    async def update_personal(
        cls,
        database: Any,
        user_id: str,
        skill_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        query = cls._owner_active_query(user_id, skill_id)
        existing = await database[cls.collection_name].find_one(query)
        if not existing:
            return None
        updates = {**updates, "updated_at": datetime.now(UTC).isoformat()}
        await database[cls.collection_name].update_one(query, {"$set": updates})
        existing.update(updates)
        return _public(existing)

    @classmethod
    async def delete_personal(cls, database: Any, user_id: str, skill_id: str) -> bool:
        query = cls._owner_active_query(user_id, skill_id)
        existing = await database[cls.collection_name].find_one(query)
        if not existing:
            return False
        await database[cls.collection_name].update_one(
            query,
            {"$set": {"status": "deleted", "updated_at": datetime.now(UTC).isoformat()}},
        )
        return True


def _public(document: dict[str, Any]) -> dict[str, Any]:
    copied = dict(document)
    copied.pop("_id", None)
    return copied


def _matches_query_text(document: dict[str, Any], query_text: str) -> bool:
    needle = query_text.strip().casefold()
    if not needle:
        return True
    values = [
        document.get("title"),
        document.get("description"),
        document.get("original_prompt"),
        *(document.get("scenes") or []),
        *(document.get("ai_tags") or []),
    ]
    return any(needle in str(value).casefold() for value in values if value is not None)
