"""Lease-based workflow event outbox. Delivery is at least once."""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings

logger = logging.getLogger(__name__)


class FlowEventPublishService:
    COLLECTION = "flow_event_outbox"
    PROTOCOL_VERSION = 2

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _new_lease_token() -> str:
        return uuid4().hex

    @classmethod
    def stable_event_id(cls, *parts: Any) -> str:
        canonical = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
        return f"wfe_{digest}"

    @classmethod
    def build_event(
        cls,
        *,
        flow_task_id: str,
        flow_run_id: str,
        command_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        event_id: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        body = dict(payload or {})
        event = {
            "command_id": command_id or body.get("command_id") or "",
            "event_id": event_id
            or cls.stable_event_id(flow_task_id, flow_run_id, command_id, event_type, body),
            "event_type": event_type,
            "flow_run_id": flow_run_id or body.get("flow_run_id") or "",
            "flow_task_id": flow_task_id or body.get("flow_task_id") or "",
            "payload": body,
            "protocol_version": cls.PROTOCOL_VERSION,
            "run_id": body.get("run_id") or flow_run_id,
        }
        resolved_trace = trace_id or body.get("trace_id")
        if resolved_trace:
            event["trace_id"] = resolved_trace
        return event

    @classmethod
    def _claim_query(cls, event_id: str, now: datetime) -> dict[str, Any]:
        return {
            "event_id": event_id,
            "$or": [
                {"status": "pending"},
                {"status": "failed", "next_attempt_at": {"$lte": now}},
                {"status": "failed", "next_attempt_at": {"$exists": False}},
                {"status": "publishing", "publish_lease_expires_at": {"$lte": now}},
                {"status": "publishing", "publish_lease_expires_at": {"$exists": False}},
            ],
        }

    @classmethod
    def _claim_update(cls, now: datetime, lease_token: str) -> dict[str, Any]:
        settings = get_settings()
        return {
            "$set": {
                "publish_claimed_at": now,
                "publish_lease_expires_at": now
                + timedelta(seconds=settings.flow_event_outbox_publish_lease_seconds),
                "publish_lease_token": lease_token,
                "status": "publishing",
                "updated_at": now,
            },
            "$inc": {"publish_attempt_count": 1},
            "$unset": {"error": "", "next_attempt_at": ""},
        }

    @classmethod
    async def _claim_event(
        cls,
        database: Any,
        *,
        event_id: str,
        insert_document: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        now = cls._now()
        lease_token = cls._new_lease_token()
        update = cls._claim_update(now, lease_token)
        if insert_document is not None:
            update["$setOnInsert"] = insert_document
        try:
            return await database[cls.COLLECTION].find_one_and_update(
                cls._claim_query(event_id, now),
                update,
                upsert=insert_document is not None,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            return None

    @classmethod
    async def _claim_next_due_event(cls, database: Any) -> dict[str, Any] | None:
        now = cls._now()
        lease_token = cls._new_lease_token()
        update = cls._claim_update(now, lease_token)
        update["$inc"]["replay_attempt_count"] = 1
        return await database[cls.COLLECTION].find_one_and_update(
            {
                "$or": [
                    {"status": "pending"},
                    {"status": "failed", "next_attempt_at": {"$lte": now}},
                    {"status": "failed", "next_attempt_at": {"$exists": False}},
                    {"status": "publishing", "publish_lease_expires_at": {"$lte": now}},
                    {"status": "publishing", "publish_lease_expires_at": {"$exists": False}},
                ]
            },
            update,
            sort=[("next_attempt_at", 1), ("publish_lease_expires_at", 1), ("created_at", 1)],
            return_document=ReturnDocument.AFTER,
        )

    @classmethod
    async def _mark_failed(
        cls,
        database: Any,
        event_id: str,
        lease_token: str,
        error: str,
    ) -> None:
        now = cls._now()
        await database[cls.COLLECTION].update_one(
            {
                "event_id": event_id,
                "publish_lease_token": lease_token,
                "status": "publishing",
            },
            {
                "$set": {
                    "error": error[:1000],
                    "next_attempt_at": now
                    + timedelta(seconds=get_settings().flow_event_outbox_retry_delay_seconds),
                    "status": "failed",
                    "updated_at": now,
                },
                "$unset": {"publish_lease_expires_at": "", "publish_lease_token": ""},
            },
        )

    @classmethod
    async def _publish_claimed(
        cls,
        database: Any,
        publisher: Any,
        outbox: dict[str, Any],
        *,
        replay: bool,
    ) -> dict[str, Any]:
        event_id = str(outbox.get("event_id") or "")
        lease_token = str(outbox.get("publish_lease_token") or "")
        queue_name = str(outbox.get("queue_name") or "")
        payload = outbox.get("payload") or outbox.get("event")
        if not event_id or not lease_token or not queue_name or not isinstance(payload, dict):
            if event_id and lease_token:
                await cls._mark_failed(
                    database,
                    event_id,
                    lease_token,
                    "outbox publish missing event_id, lease, queue, or payload",
                )
            raise RuntimeError("outbox publish missing event_id, lease, queue, or payload")

        try:
            await publisher.publish(queue_name=queue_name, payload=payload)
        except Exception as exc:
            await cls._mark_failed(database, event_id, lease_token, str(exc))
            raise

        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {
                "event_id": event_id,
                "publish_lease_token": lease_token,
                "status": "publishing",
            },
            {
                "$set": {
                    "expires_at": now
                    + timedelta(seconds=get_settings().flow_event_outbox_retention_seconds),
                    "sent_at": now,
                    "status": "sent",
                    "updated_at": now,
                    **({"replayed_at": now} if replay else {}),
                },
                "$unset": {
                    "error": "",
                    "next_attempt_at": "",
                    "publish_lease_expires_at": "",
                    "publish_lease_token": "",
                },
            },
        )
        if getattr(result, "matched_count", 0) != 1:
            logger.warning(
                "outbox message sent but publish lease was lost event_id=%s",
                event_id,
            )
        return await database[cls.COLLECTION].find_one({"event_id": event_id}) or outbox

    @classmethod
    async def publish(
        cls,
        database: Any,
        publisher: Any,
        *,
        queue_name: str,
        flow_task_id: str,
        flow_run_id: str,
        command_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        event_id: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        event = cls.build_event(
            flow_task_id=flow_task_id,
            flow_run_id=flow_run_id,
            command_id=command_id,
            event_type=event_type,
            payload=payload,
            event_id=event_id,
            trace_id=trace_id,
        )
        return await cls.publish_event(database, publisher, queue_name=queue_name, event=event)

    @classmethod
    async def publish_event(
        cls,
        database: Any,
        publisher: Any,
        *,
        queue_name: str,
        event: dict[str, Any],
    ) -> dict[str, Any]:
        event_id = str(event["event_id"])
        now = cls._now()
        flow_run_id = str(event.get("flow_run_id") or event.get("run_id") or "")
        insert_document = {
            "_id": event_id,
            "command_id": event.get("command_id"),
            "created_at": now,
            "event": event,
            "event_id": event_id,
            "event_type": event.get("event_type"),
            "flow_run_id": flow_run_id,
            "flow_task_id": event.get("flow_task_id"),
            "payload": event,
            "protocol_version": event.get("protocol_version") or cls.PROTOCOL_VERSION,
            "queue_name": queue_name,
            "run_id": event.get("run_id") or flow_run_id,
            "status": "pending",
            "trace_id": event.get("trace_id"),
        }
        claimed = await cls._claim_event(
            database,
            event_id=event_id,
            insert_document=insert_document,
        )
        if not claimed:
            existing = await database[cls.COLLECTION].find_one({"event_id": event_id})
            logger.info(
                "outbox event already sent or leased event_id=%s status=%s",
                event_id,
                (existing or {}).get("status"),
            )
            return existing or insert_document
        return await cls._publish_claimed(database, publisher, claimed, replay=False)

    @classmethod
    async def replay_due_events(
        cls,
        database: Any,
        publisher: Any,
        *,
        limit: int = 100,
    ) -> int:
        replayed = 0
        for _ in range(limit):
            outbox = await cls._claim_next_due_event(database)
            if not outbox:
                break
            try:
                await cls._publish_claimed(database, publisher, outbox, replay=True)
            except Exception:
                continue
            replayed += 1
        return replayed
