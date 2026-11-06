"""Share persistence helpers."""

from copy import deepcopy
from typing import Any


class ShareDao:
    collection_name = "shares"

    @classmethod
    async def create(cls, database: Any, document: dict[str, Any]) -> dict[str, Any]:
        stored = deepcopy(document)
        await database[cls.collection_name].insert_one(stored)
        return cls._public_document(stored)

    @classmethod
    async def get_by_share_id(cls, database: Any, share_id: str) -> dict[str, Any] | None:
        document = await database[cls.collection_name].find_one({"share_id": share_id}, {"_id": 0})
        if document is None:
            return None
        return cls._public_document(document)

    @staticmethod
    def _public_document(document: dict[str, Any]) -> dict[str, Any]:
        output = deepcopy(document)
        output.pop("_id", None)
        return output
