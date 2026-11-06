"""App Flow persistence helpers."""

from copy import deepcopy
from typing import Any


class AppFlowDao:
    collection_name = "app_flows"

    @classmethod
    async def create(cls, database: Any, document: dict[str, Any]) -> dict[str, Any]:
        stored = deepcopy(document)
        await database[cls.collection_name].insert_one(stored)
        return cls._public_document(stored)

    @classmethod
    async def get_by_flow_id(cls, database: Any, flow_id: str) -> dict[str, Any] | None:
        document = await database[cls.collection_name].find_one({"flow_id": flow_id}, {"_id": 0})
        if document is None:
            return None
        return cls._public_document(document)

    @classmethod
    async def exists_by_flow_id(cls, database: Any, flow_id: str) -> bool:
        document = await database[cls.collection_name].find_one({"flow_id": flow_id}, {"_id": 1})
        return document is not None

    @classmethod
    async def update_by_flow_id(
        cls,
        database: Any,
        flow_id: str,
        update_data: dict[str, Any],
    ) -> bool:
        result = await database[cls.collection_name].update_one(
            {"flow_id": flow_id},
            {"$set": update_data},
        )
        return bool(result.matched_count)

    @staticmethod
    def _public_document(document: dict[str, Any]) -> dict[str, Any]:
        output = deepcopy(document)
        output.pop("_id", None)
        return output
