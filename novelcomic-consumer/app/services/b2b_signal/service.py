"""Consumer-side B2B signal emitter.

This mirrors the Publisher event shape because worker tasks may be the actual
place where workflow starts or credits are deducted.
"""

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

log = logging.getLogger(__name__)

EVENT_COLLECTION = "b2b_signal_events"


async def emit_event(
    database: Any,
    *,
    user_id: str,
    event_type: str,
    source_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
) -> None:
    try:
        await database[EVENT_COLLECTION].insert_one(
            {
                "event_id": uuid4().hex,
                "event_type": event_type,
                "source_id": source_id,
                "metadata": metadata or {},
                "user_id": user_id,
                "created_at": occurred_at or datetime.now(UTC),
            }
        )
    except Exception:
        log.exception(
            "Consumer B2B signal emit failed: user_id=%s event_type=%s source_id=%s",
            user_id,
            event_type,
            source_id,
        )
