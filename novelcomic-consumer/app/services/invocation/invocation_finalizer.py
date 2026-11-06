"""Claim finalize_status before writing invocation results."""

from __future__ import annotations

import logging
from typing import Any

from app.services.workflow.flow_run_state_service import FlowRunStateService

logger = logging.getLogger(__name__)

FINALIZE_CLAIM_STATUSES = ["pending", "failed"]


class InvocationFinalizer:
    @classmethod
    async def run_finalize(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        invocation_id: str,
        force: bool = False,
    ) -> dict[str, Any] | None:
        from app.services.invocation.model_invocation_service import ModelInvocationService

        now = FlowRunStateService._now()
        claim_statuses = ["pending", "failed", "running"] if force else FINALIZE_CLAIM_STATUSES
        claim = await database[ModelInvocationService.COLLECTION].update_one(
            {
                "finalize_status": {"$in": claim_statuses},
                "invocation_id": invocation_id,
            },
            {
                "$inc": {"finalize_attempt_count": 1},
                "$set": {
                    "finalize_started_at": now,
                    "finalize_status": "running",
                    "updated_at": now,
                },
                "$unset": {"finalize_error": ""},
            },
        )
        if getattr(claim, "matched_count", 0) != 1:
            current = await database[ModelInvocationService.COLLECTION].find_one(
                {"invocation_id": invocation_id}
            )
            logger.info(
                "finalize claim missed invocation_id=%s finalize_status=%s",
                invocation_id,
                (current or {}).get("finalize_status"),
            )
            return current

        invocation = await database[ModelInvocationService.COLLECTION].find_one(
            {"invocation_id": invocation_id}
        )
        if invocation is None:
            return None
        try:
            completed = await ModelInvocationService.complete_from_callback(
                database,
                redis_client=redis_client,
                publisher=publisher,
                invocation=invocation,
            )
        except Exception as exc:
            await database[ModelInvocationService.COLLECTION].update_one(
                {"invocation_id": invocation_id, "finalize_status": "running"},
                {
                    "$set": {
                        "finalize_error": str(exc)[:1000],
                        "finalize_status": "failed",
                        "updated_at": FlowRunStateService._now(),
                    }
                },
            )
            raise

        await database[ModelInvocationService.COLLECTION].update_one(
            {"finalize_status": "running", "invocation_id": invocation_id},
            {
                "$set": {
                    "finalize_finished_at": FlowRunStateService._now(),
                    "finalize_status": "done",
                    "updated_at": FlowRunStateService._now(),
                },
                "$unset": {"finalize_error": ""},
            },
        )
        done = await database[ModelInvocationService.COLLECTION].find_one(
            {"invocation_id": invocation_id}
        )
        return done or completed

    @classmethod
    async def schedule_finalize(
        cls,
        database: Any,
        *,
        redis_client: Any | None,
        publisher: Any,
        invocation_id: str,
    ) -> bool:
        finalized = await cls.run_finalize(
            database,
            redis_client=redis_client,
            publisher=publisher,
            invocation_id=invocation_id,
        )
        return (finalized or {}).get("finalize_status") in {"done", "running"}
