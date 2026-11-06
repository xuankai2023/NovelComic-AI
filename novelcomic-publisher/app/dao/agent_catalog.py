"""Mongo access for the public Agent catalog."""

from copy import deepcopy
from typing import Any, Literal

CatalogKind = Literal["hook", "role"]


class AgentCatalogDao:
    collection_name = "agent_catalog"

    @staticmethod
    async def _cursor_to_list(cursor: Any, *, length: int | None = None) -> list[dict[str, Any]]:
        if hasattr(cursor, "to_list"):
            return await cursor.to_list(length=length)
        output: list[dict[str, Any]] = []
        async for item in cursor:
            output.append(item)
        return output

    @classmethod
    async def list_published(
        cls,
        database: Any,
        kind: CatalogKind,
    ) -> list[dict[str, Any]]:
        cursor = database[cls.collection_name].find(
            {"kind": kind, "status": "published"},
            {"_id": 0},
        )
        docs = await cls._cursor_to_list(cursor)
        return [cls._public_document(doc) for doc in docs]

    @staticmethod
    def _public_document(document: dict[str, Any]) -> dict[str, Any]:
        output = deepcopy(document)
        output.pop("_id", None)
        return output
