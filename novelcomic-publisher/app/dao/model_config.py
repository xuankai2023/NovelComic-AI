"""Mongo and Redis access for model configuration."""

import json
from datetime import UTC, datetime
from typing import Any

_REDIS_KEY_PREFIX = "model_config:"
_REDIS_ALL_CONFIGS_KEY = "model_config:__all__"


def _redis_key(config_name: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{config_name}"


class ModelConfigDao:
    collection_name = "model_configs"

    @staticmethod
    async def _cursor_to_list(cursor: Any, *, length: int | None = None) -> list[dict[str, Any]]:
        if hasattr(cursor, "to_list"):
            return await cursor.to_list(length=length)
        output: list[dict[str, Any]] = []
        async for item in cursor:
            output.append(item)
        return output

    @classmethod
    async def find_by_config_name(cls, database: Any, config_name: str) -> list[dict[str, Any]]:
        cursor = database[cls.collection_name].find({"config_name": config_name}, {"_id": 0})
        return await cls._cursor_to_list(cursor)

    @classmethod
    async def find_one(
        cls,
        database: Any,
        config_name: str,
        model_id: str,
    ) -> dict[str, Any] | None:
        return await database[cls.collection_name].find_one(
            {"config_name": config_name, "model_id": model_id},
            {"_id": 0},
        )

    @classmethod
    async def find_all(cls, database: Any) -> list[dict[str, Any]]:
        cursor = database[cls.collection_name].find({}, {"_id": 0})
        return await cls._cursor_to_list(cursor)

    @classmethod
    async def upsert(
        cls,
        database: Any,
        config_name: str,
        model_id: str,
        data: dict[str, Any],
    ) -> None:
        doc: dict[str, Any] = {
            "config_name": config_name,
            "model_id": model_id,
            "display_name": data.get("display_name", model_id),
            "pricing": data.get("pricing"),
            "params": data.get("params") or {},
            "updated_at": datetime.now(UTC),
        }
        update: dict[str, Any] = {"$set": doc}
        if data.get("input_mapping"):
            doc["input_mapping"] = data["input_mapping"]
        else:
            update["$unset"] = {"input_mapping": ""}

        await database[cls.collection_name].update_one(
            {"config_name": config_name, "model_id": model_id},
            update,
            upsert=True,
        )

    @classmethod
    async def delete_one(cls, database: Any, config_name: str, model_id: str) -> bool:
        result = await database[cls.collection_name].delete_one(
            {"config_name": config_name, "model_id": model_id}
        )
        return result.deleted_count > 0

    @classmethod
    async def update_sort_fields(
        cls,
        database: Any,
        patches: list[dict[str, Any]],
    ) -> dict[str, list[dict[str, str | None]]]:
        updated: list[dict[str, str | None]] = []
        unmatched: list[dict[str, str | None]] = []
        for patch in patches:
            config_name = patch.get("config_name")
            model_id = patch.get("model_id")
            identity = {"config_name": config_name, "model_id": model_id}
            if not config_name or not model_id:
                unmatched.append(identity)
                continue

            set_fields = dict(patch.get("set") or {})
            unset_fields = dict(patch.get("unset") or {})
            set_fields["updated_at"] = datetime.now(UTC)
            update: dict[str, Any] = {"$set": set_fields}
            if unset_fields:
                update["$unset"] = unset_fields

            result = await database[cls.collection_name].update_one(
                {"config_name": config_name, "model_id": model_id},
                update,
            )
            if result.matched_count == 0:
                unmatched.append(identity)
            else:
                updated.append(identity)
        return {"updated": updated, "unmatched": unmatched}

    @staticmethod
    def _cache_entry(doc: dict[str, Any]) -> dict[str, Any]:
        model_id = doc["model_id"]
        entry = {
            "display_name": doc.get("display_name", model_id),
            "pricing": doc.get("pricing"),
            "params": doc.get("params") or {},
        }
        if doc.get("input_mapping"):
            entry["input_mapping"] = doc["input_mapping"]
        return entry

    @classmethod
    async def refresh_redis_cache(cls, database: Any, redis_client: Any, config_name: str) -> None:
        docs = await cls.find_by_config_name(database, config_name)
        cache = {doc["model_id"]: cls._cache_entry(doc) for doc in docs}
        if cache:
            await redis_client.set(_redis_key(config_name), json.dumps(cache))
        else:
            await redis_client.delete(_redis_key(config_name))

    @classmethod
    async def refresh_all_redis_cache(cls, database: Any, redis_client: Any) -> None:
        docs = await cls.find_all(database)
        merged = {doc["model_id"]: cls._cache_entry(doc) for doc in docs}
        await redis_client.set(_REDIS_ALL_CONFIGS_KEY, json.dumps(merged))
