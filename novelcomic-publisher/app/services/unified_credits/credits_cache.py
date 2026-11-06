"""Redis keys for credit grants. Mongo remains the source of truth."""

import asyncio
import logging
from typing import Any

import redis.asyncio as redis

from app.config import get_settings

log = logging.getLogger(__name__)

CREDITS_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60
SUBSCRIPTION_SETTLEMENT_LOCK_TTL_SECONDS = 300


class CreditsCache:
    """Small Redis wrapper so tests can replace the client."""

    _client_override: Any = None
    _default_client: Any = None
    _default_client_loop: Any = None
    _fallback_store: dict[str, str] = {}

    @classmethod
    def _client(cls) -> Any:
        if cls._client_override is not None:
            return cls._client_override
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if cls._default_client is None or cls._default_client_loop is not loop:
            cls._default_client = redis.from_url(get_settings().redis_url, decode_responses=True)
            cls._default_client_loop = loop
        return cls._default_client

    @classmethod
    async def set_if_absent(cls, key: str, value: str, ttl_seconds: int) -> bool:
        if cls._client_override is not None:
            result = await cls._client_override.set(key, value, ex=ttl_seconds, nx=True)
            return result is True or result == "OK"
        try:
            result = await cls._client().set(key, value, ex=ttl_seconds, nx=True)
            return result is True or result == "OK"
        except Exception:
            if key in cls._fallback_store:
                return False
            cls._fallback_store[key] = value
            return True

    @classmethod
    async def delete(cls, key: str) -> None:
        if cls._client_override is not None:
            await cls._client_override.delete(key)
            return
        try:
            await cls._client().delete(key)
        except Exception:
            cls._fallback_store.pop(key, None)

    @classmethod
    async def delete_quietly(cls, key: str) -> None:
        try:
            await cls.delete(key)
        except Exception:
            log.warning("Failed to delete credit cache key: %s", key, exc_info=True)
