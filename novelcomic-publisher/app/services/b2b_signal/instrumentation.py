"""Best-effort B2B event instrumentation."""

import logging
from datetime import datetime
from typing import Any

from app.services.b2b_signal.service import B2BSignalService

log = logging.getLogger(__name__)


async def emit_b2b_signal_safely(
    database: Any,
    *,
    user_id: str,
    event_type: str,
    source_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
) -> None:
    try:
        await B2BSignalService.emit_event(
            database,
            user_id=user_id,
            event_type=event_type,
            source_id=source_id,
            metadata=metadata,
            occurred_at=occurred_at,
        )
    except Exception:
        log.exception(
            "B2B signal emit failed: user_id=%s event_type=%s source_id=%s",
            user_id,
            event_type,
            source_id,
        )


async def emit_payment_succeeded(
    database: Any,
    *,
    user_id: str,
    payment_id: str,
    paid_at: datetime | None = None,
) -> None:
    await emit_b2b_signal_safely(
        database,
        user_id=user_id,
        event_type="payment_succeeded",
        source_id=payment_id,
        occurred_at=paid_at,
    )
