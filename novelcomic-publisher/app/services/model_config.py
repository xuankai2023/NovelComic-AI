"""Model configuration orchestration."""

import logging
from copy import deepcopy
from typing import Any

from app.dao.model_config import ModelConfigDao

log = logging.getLogger(__name__)

BUILT_IN_PUBLIC_MODEL_CONFIGS: tuple[dict[str, Any], ...] = (
    {
        "config_name": "text_to_image_config",
        "model_id": "kie-image-v1",
        "display_name": "KIE Image",
        "brand": "kie",
        "dropdown_groups": ["text_to_image"],
        "params": {
            "prompt": {"type": "string", "required": True, "minLength": 1, "maxLength": 5000},
            "negative_prompt": {"type": "string", "required": False, "maxLength": 5000},
            "aspect_ratio": {"type": "string", "required": False},
            "size": {"type": "string", "required": False},
            "seed": {"type": "number", "required": False},
        },
    },
)


def _built_in_public_configs() -> list[dict[str, Any]]:
    return [deepcopy(config) for config in BUILT_IN_PUBLIC_MODEL_CONFIGS]


def _merge_public_configs(
    stored: list[dict[str, Any]],
    built_in: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for doc in stored + built_in:
        config_name = doc.get("config_name")
        model_id = doc.get("model_id")
        if not isinstance(config_name, str) or not isinstance(model_id, str):
            continue
        key = (config_name, model_id)
        if key in seen:
            continue
        seen.add(key)
        merged.append(doc)
    return merged


class ModelConfigService:
    @staticmethod
    async def list_by_config_name(database: Any, config_name: str) -> list[dict[str, Any]]:
        stored = await ModelConfigDao.find_by_config_name(database, config_name)
        built_in = [
            doc for doc in _built_in_public_configs()
            if doc.get("config_name") == config_name
        ]
        return _merge_public_configs(stored, built_in)

    @staticmethod
    async def get_one(database: Any, config_name: str, model_id: str) -> dict[str, Any] | None:
        stored = await ModelConfigDao.find_one(database, config_name, model_id)
        if stored is not None:
            return stored
        return next(
            (
                doc for doc in _built_in_public_configs()
                if doc.get("config_name") == config_name and doc.get("model_id") == model_id
            ),
            None,
        )

    @staticmethod
    async def list_all(database: Any) -> list[dict[str, Any]]:
        return _merge_public_configs(
            await ModelConfigDao.find_all(database),
            _built_in_public_configs(),
        )

    @staticmethod
    async def _refresh_redis(database: Any, redis_client: Any, config_name: str) -> None:
        try:
            await ModelConfigDao.refresh_redis_cache(database, redis_client, config_name)
            await ModelConfigDao.refresh_all_redis_cache(database, redis_client)
        except Exception:
            log.exception("Failed to refresh model config Redis cache for %s", config_name)

    @staticmethod
    async def upsert(
        database: Any,
        redis_client: Any,
        config_name: str,
        model_id: str,
        data: dict[str, Any],
    ) -> None:
        await ModelConfigDao.upsert(database, config_name, model_id, data)
        await ModelConfigService._refresh_redis(database, redis_client, config_name)

    @staticmethod
    async def delete(database: Any, redis_client: Any, config_name: str, model_id: str) -> bool:
        success = await ModelConfigDao.delete_one(database, config_name, model_id)
        if success:
            await ModelConfigService._refresh_redis(database, redis_client, config_name)
        return success
