"""DAO for developer_api_client collection."""

import hashlib
import secrets
from datetime import UTC, datetime
from typing import Any

from app.schemas.developer_api_client import DeveloperApiClient


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def generate_sk_api_key() -> str:
    return f"sk_{secrets.token_urlsafe(24)}"


class DeveloperApiClientDao:
    COLLECTION = "developer_api_client"

    @classmethod
    async def create(
        cls,
        database: Any,
        *,
        owner_user_id: str,
        name: str,
        rate_limit_per_minute: int | None = None,
        allowed_flow_ids: list[str] | None = None,
    ) -> DeveloperApiClient:
        raw_key = generate_sk_api_key()
        client = DeveloperApiClient(
            name=name.strip(),
            owner_user_id=owner_user_id,
            api_key=raw_key,
            api_key_hash=hash_api_key(raw_key),
            key_suffix=raw_key[-4:],
            allowed_flow_ids=list(allowed_flow_ids or []),
            rate_limit_per_minute=rate_limit_per_minute,
        )
        await database[cls.COLLECTION].insert_one(client.model_dump(mode="json"))
        return client

    @classmethod
    async def get_by_key_hash(cls, database: Any, api_key_hash: str) -> dict[str, Any] | None:
        doc = await database[cls.COLLECTION].find_one(
            {"api_key_hash": api_key_hash, "status": "active"}
        )
        return dict(doc) if doc is not None else None

    @classmethod
    async def list_by_owner(cls, database: Any, owner_user_id: str) -> list[dict[str, Any]]:
        cursor = (
            database[cls.COLLECTION]
            .find({"owner_user_id": owner_user_id, "status": "active"}, {"_id": 0})
            .sort("created_at", -1)
            .limit(100)
        )
        if hasattr(cursor, "to_list"):
            items = await cursor.to_list(length=100)
        else:
            items = list(cursor)
        return [
            {k: v for k, v in dict(item).items() if k not in {"_id", "api_key_hash"}}
            for item in items
        ]

    @classmethod
    async def revoke(cls, database: Any, *, client_id: str, owner_user_id: str) -> bool:
        result = await database[cls.COLLECTION].update_one(
            {"client_id": client_id, "owner_user_id": owner_user_id, "status": "active"},
            {"$set": {"status": "revoked", "updated_at": datetime.now(UTC)}},
        )
        return bool(getattr(result, "modified_count", 0) or getattr(result, "matched_count", 0))
