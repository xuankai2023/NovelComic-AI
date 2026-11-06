"""B2B signal event storage and pending action lifecycle."""

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.services.b2b_signal.feishu_client import B2BFeishuClient
from app.services.b2b_signal.rules import (
    B2B_UPGRADE_ACTION_ID,
    build_upgrade_action,
    should_create_upgrade_action,
)

EVENT_COLLECTION = "b2b_signal_events"
ACTION_COLLECTION = "b2b_signal_actions"
NOTIFICATION_COLLECTION = "b2b_signal_notifications"

log = logging.getLogger(__name__)


class B2BSignalService:
    @classmethod
    async def emit_event(
        cls,
        database: Any,
        *,
        user_id: str,
        event_type: str,
        source_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        occurred_at: datetime | None = None,
    ) -> dict[str, Any]:
        now = occurred_at or datetime.now(UTC)
        event = {
            "event_id": uuid4().hex,
            "event_type": event_type,
            "source_id": source_id,
            "metadata": metadata or {},
            "user_id": user_id,
            "created_at": now,
        }
        await database[EVENT_COLLECTION].insert_one(event)
        await cls._refresh_upgrade_action(database, user_id=user_id, now=now)
        return event

    @classmethod
    async def _refresh_upgrade_action(
        cls,
        database: Any,
        *,
        user_id: str,
        now: datetime,
    ) -> None:
        existing = await database[ACTION_COLLECTION].find_one(
            {"user_id": user_id, "action_id": B2B_UPGRADE_ACTION_ID}
        )
        if existing is not None:
            return

        events = await database[EVENT_COLLECTION].find({"user_id": user_id}).to_list(length=100)
        if not should_create_upgrade_action(events):
            return

        action = build_upgrade_action(user_id, now=now)
        await database[ACTION_COLLECTION].insert_one(action)
        await cls._notify_signal_if_needed(database, action=action)

    @classmethod
    async def _notify_signal_if_needed(
        cls,
        database: Any,
        *,
        action: dict[str, Any],
        trigger_event_id: str | None = None,
        feishu_client: B2BFeishuClient | None = None,
    ) -> bool:
        notification_id = f"{action.get('user_id')}:{action.get('action_id')}"
        now = datetime.now(UTC)
        try:
            notification = await database[NOTIFICATION_COLLECTION].find_one_and_update(
                {
                    "_id": notification_id,
                    "status": {"$nin": ["sent", "sending"]},
                },
                {
                    "$setOnInsert": {
                        "_id": notification_id,
                        "notification_id": notification_id,
                        "user_id": action.get("user_id"),
                        "action_id": action.get("action_id"),
                        "created_at": now,
                    },
                    "$set": {
                        "status": "sending",
                        "trigger_event_id": trigger_event_id,
                        "updated_at": now,
                    },
                    "$unset": {"error": ""},
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            return False

        if notification is None:
            return False

        client = feishu_client or B2BFeishuClient()
        try:
            await client.send_expiring_action_card(
                {
                    **action,
                    **({"trigger_event_id": trigger_event_id} if trigger_event_id else {}),
                }
            )
        except Exception as exc:
            await database[NOTIFICATION_COLLECTION].update_one(
                {"_id": notification_id, "status": "sending"},
                {
                    "$set": {
                        "status": "failed",
                        "error": str(exc),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            log.error(
                "B2BSignalService: failed to send Feishu card, notification_id=%s error=%s",
                notification_id,
                exc,
                exc_info=True,
            )
            return False

        await database[NOTIFICATION_COLLECTION].update_one(
            {"_id": notification_id, "status": "sending"},
            {
                "$set": {
                    "status": "sent",
                    "sent_at": datetime.now(UTC),
                    "updated_at": datetime.now(UTC),
                },
                "$unset": {"error": ""},
            },
        )
        return True

    @classmethod
    async def list_pending_actions(
        cls,
        database: Any,
        *,
        user_id: str,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        current = now or datetime.now(UTC)
        cursor = database[ACTION_COLLECTION].find(
            {"user_id": user_id, "status": "pending"},
            {"_id": 0},
        )
        actions = await cursor.to_list(length=50)
        return [
            action
            for action in actions
            if action.get("expires_at") is None or action["expires_at"] >= current
        ]

    @classmethod
    async def mark_action_shown(
        cls,
        database: Any,
        *,
        user_id: str,
        action_id: str,
        now: datetime | None = None,
    ) -> bool:
        result = await database[ACTION_COLLECTION].update_one(
            {"user_id": user_id, "action_id": action_id, "status": "pending"},
            {"$set": {"status": "shown", "shown_at": now or datetime.now(UTC)}},
        )
        return bool(getattr(result, "matched_count", 0))
