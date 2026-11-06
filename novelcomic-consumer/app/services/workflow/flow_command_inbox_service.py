"""Durable, lease-based inbox for safely reapplying v2 commands."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings


@dataclass(frozen=True)
class FlowCommandClaim:
    claimed: bool
    document: dict[str, Any]
    conflict: bool = False
    lease_token: str | None = None


class FlowCommandInboxService:
    COLLECTION = "flow_command_inbox"

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @staticmethod
    def _new_lease_token() -> str:
        return uuid4().hex

    @staticmethod
    def payload_hash(payload: dict[str, Any]) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _wrote(result: Any) -> bool:
        matched = getattr(result, "matched_count", None)
        if isinstance(matched, int):
            return matched == 1
        return bool(getattr(result, "modified_count", 0))

    @classmethod
    async def claim_command(
        cls,
        database: Any,
        *,
        command_id: str,
        protocol_version: int,
        command_type: str,
        flow_task_id: str,
        flow_run_id: str,
        payload: dict[str, Any],
        redelivery_payload: dict[str, Any],
    ) -> FlowCommandClaim:
        now = cls._now()
        payload_hash = cls.payload_hash(payload)
        lease_token = cls._new_lease_token()
        identity = {
            "_id": command_id,
            "command_id": command_id,
            "protocol_version": protocol_version,
            "command_type": command_type,
            "flow_task_id": flow_task_id,
            "flow_run_id": flow_run_id,
            "payload_hash": payload_hash,
        }
        claim_filter = {
            **identity,
            "$or": [
                {"status": "processing", "lease_expires_at": {"$lte": now}},
                {"status": "processing", "lease_expires_at": {"$exists": False}},
                {"status": "failed", "next_attempt_at": {"$lte": now}},
                {"status": "failed", "next_attempt_at": {"$exists": False}},
            ],
        }
        claim_update = {
            "$setOnInsert": {**identity, "created_at": now},
            "$set": {
                "status": "processing",
                "redelivery_payload": redelivery_payload,
                "lease_token": lease_token,
                "lease_expires_at": now
                + timedelta(seconds=get_settings().flow_command_inbox_lease_seconds),
                "updated_at": now,
            },
            "$inc": {"attempts": 1},
            "$unset": {
                "error": "",
                "failed_at": "",
                "next_attempt_at": "",
                "expires_at": "",
                "redelivery_lease_token": "",
                "redelivery_lease_expires_at": "",
                "redelivery_error": "",
            },
        }
        collection = database[cls.COLLECTION]
        existing = None
        for _ in range(2):
            try:
                claimed_document = await collection.find_one_and_update(
                    claim_filter,
                    claim_update,
                    upsert=True,
                    return_document=ReturnDocument.AFTER,
                )
                if claimed_document is None:
                    raise RuntimeError(f"workflow command claim disappeared: {command_id}")
                return FlowCommandClaim(
                    claimed=True,
                    document=claimed_document,
                    lease_token=lease_token,
                )
            except DuplicateKeyError:
                existing = await collection.find_one({"_id": command_id})
                if existing is not None:
                    break

        if existing is None:
            raise RuntimeError(f"workflow command claim disappeared: {command_id}")

        conflict = any(
            existing.get(field) != identity.get(field)
            for field in (
                "protocol_version",
                "command_type",
                "flow_task_id",
                "flow_run_id",
                "payload_hash",
            )
        )
        return FlowCommandClaim(claimed=False, document=existing, conflict=conflict)

    @classmethod
    async def mark_completed(cls, database: Any, command_id: str, lease_token: str) -> bool:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"_id": command_id, "status": "processing", "lease_token": lease_token},
            {
                "$set": {
                    "status": "completed",
                    "completed_at": now,
                    "expires_at": now
                    + timedelta(seconds=get_settings().flow_command_inbox_retention_seconds),
                    "updated_at": now,
                },
                "$unset": {
                    "lease_token": "",
                    "lease_expires_at": "",
                    "next_attempt_at": "",
                },
            },
        )
        return cls._wrote(result)

    @classmethod
    async def mark_failed(
        cls,
        database: Any,
        command_id: str,
        lease_token: str,
        error: str | None,
    ) -> bool:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"_id": command_id, "status": "processing", "lease_token": lease_token},
            {
                "$set": {
                    "status": "failed",
                    "error": (error or "")[:1000],
                    "failed_at": now,
                    "next_attempt_at": now
                    + timedelta(seconds=get_settings().flow_command_inbox_failed_retry_delay_seconds),
                    "updated_at": now,
                },
                "$unset": {
                    "lease_token": "",
                    "lease_expires_at": "",
                    "expires_at": "",
                },
            },
        )
        return cls._wrote(result)

    @classmethod
    async def claim_due_redelivery(cls, database: Any) -> dict[str, Any] | None:
        now = cls._now()
        redelivery_token = cls._new_lease_token()
        return await database[cls.COLLECTION].find_one_and_update(
            {
                "redelivery_payload": {"$type": "object"},
                "$and": [
                    {
                        "$or": [
                            {"status": "processing", "lease_expires_at": {"$lte": now}},
                            {"status": "processing", "lease_expires_at": {"$exists": False}},
                            {"status": "failed", "next_attempt_at": {"$lte": now}},
                            {"status": "failed", "next_attempt_at": {"$exists": False}},
                        ]
                    },
                    {
                        "$or": [
                            {"redelivery_lease_expires_at": {"$lte": now}},
                            {"redelivery_lease_expires_at": {"$exists": False}},
                        ]
                    },
                ],
            },
            {
                "$set": {
                    "redelivery_lease_token": redelivery_token,
                    "redelivery_lease_expires_at": now
                    + timedelta(seconds=get_settings().flow_command_inbox_redelivery_lease_seconds),
                    "redelivery_claimed_at": now,
                    "updated_at": now,
                },
                "$inc": {"redelivery_attempts": 1},
                "$unset": {"redelivery_error": ""},
            },
            sort=[("next_attempt_at", 1), ("lease_expires_at", 1), ("created_at", 1)],
            return_document=ReturnDocument.AFTER,
        )

    @classmethod
    async def mark_redelivery_enqueued(
        cls,
        database: Any,
        command_id: str,
        redelivery_lease_token: str,
    ) -> bool:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"_id": command_id, "redelivery_lease_token": redelivery_lease_token},
            {
                "$set": {"last_redelivered_at": now, "updated_at": now},
                "$unset": {"redelivery_lease_token": "", "redelivery_error": ""},
            },
        )
        return cls._wrote(result)

    @classmethod
    async def mark_redelivery_failed(
        cls,
        database: Any,
        command_id: str,
        redelivery_lease_token: str,
        error: str,
    ) -> bool:
        now = cls._now()
        result = await database[cls.COLLECTION].update_one(
            {"_id": command_id, "redelivery_lease_token": redelivery_lease_token},
            {
                "$set": {
                    "redelivery_error": error[:1000],
                    "redelivery_lease_expires_at": now
                    + timedelta(seconds=get_settings().flow_command_inbox_failed_retry_delay_seconds),
                    "updated_at": now,
                },
                "$unset": {"redelivery_lease_token": ""},
            },
        )
        return cls._wrote(result)
