"""Webhook idempotency support."""

from datetime import UTC, datetime
from typing import Any


class WebhookProcessServiceSupport:
    COLLECTION = "webhook_events"

    @classmethod
    async def already_succeeded(cls, database: Any, *, provider: str, event_id: str) -> bool:
        existing = await database[cls.COLLECTION].find_one(
            {"provider": provider, "event_id": event_id, "status": "succeeded"}
        )
        return existing is not None

    @classmethod
    async def mark_processing(
        cls,
        database: Any,
        *,
        provider: str,
        event_id: str,
        event_type: str,
    ) -> None:
        await database[cls.COLLECTION].insert_one(
            {
                "provider": provider,
                "event_id": event_id,
                "event_type": event_type,
                "status": "processing",
                "created_at": datetime.now(UTC),
                "updated_at": datetime.now(UTC),
            }
        )

    @classmethod
    async def mark_succeeded(cls, database: Any, *, provider: str, event_id: str) -> None:
        await database[cls.COLLECTION].update_one(
            {"provider": provider, "event_id": event_id},
            {"$set": {"status": "succeeded", "updated_at": datetime.now(UTC)}},
        )

    @classmethod
    async def mark_failed(
        cls,
        database: Any,
        *,
        provider: str,
        event_id: str,
        error: str,
    ) -> None:
        await database[cls.COLLECTION].update_one(
            {"provider": provider, "event_id": event_id},
            {"$set": {"status": "failed", "error": error, "updated_at": datetime.now(UTC)}},
        )

    @classmethod
    async def ensure_indexes(cls, database: Any) -> None:
        create_index = getattr(database[cls.COLLECTION], "create_index", None)
        if create_index is None:
            return
        await create_index(
            [("provider", 1), ("event_id", 1)],
            unique=True,
            name="webhook_events_provider_event_uidx",
        )
