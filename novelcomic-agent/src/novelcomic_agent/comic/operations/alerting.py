"""Deduplicated alerts. A channel failure never changes a production."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, Protocol

from ..persistence.ledger import Ledger
from ..persistence.rows import AlertRow, utcnow

AlertKind = Literal[
    "budget",
    "lease-timeout",
    "outbox-backlog",
    "render-stuck",
    "package-corrupt",
    "downgrade-spike",
]
_WINDOW = timedelta(minutes=15)
_SECRET = re.compile(r"(token|authorization|secret|password|signed)", re.IGNORECASE)
_URL = re.compile(r"https?://\S+")


@dataclass(frozen=True, slots=True)
class AlertFact:
    tenant_id: str
    production_id: str | None
    stage: str
    error_code: str
    kind: AlertKind
    observed_at: datetime
    recovered: bool = False
    details: dict[str, Any] | None = None


class AlertChannel(Protocol):
    async def publish(self, body: dict[str, Any]) -> None:
        """Deliver one firing alert."""

    async def resolve(self, dedup_key: str) -> None:
        """Deliver one recovery."""


class AlertService:
    def __init__(
        self, ledger: Ledger, channel: AlertChannel, clock: Any | None = None
    ) -> None:
        self._ledger = ledger
        self._channel = channel
        self._clock = clock or utcnow

    async def handle(self, fact: AlertFact) -> AlertRow:
        window = window_start(fact.observed_at)
        key = dedup_key(
            tenant_id=fact.tenant_id,
            production_id=fact.production_id,
            stage=fact.stage,
            error_code=fact.error_code,
            window_start=window,
        )
        summary = f"{fact.kind} {fact.stage} {fact.error_code}"
        details = sanitize(fact.details or {})
        now = self._clock()
        async with self._ledger.transaction() as session:
            current = await session.get_alert(key)
            if current is None:
                current = AlertRow(
                    dedup_key=key,
                    tenant_id=fact.tenant_id,
                    production_id=fact.production_id,
                    stage=fact.stage,
                    error_code=fact.error_code,
                    window_start=window,
                    status="firing",
                    summary=summary,
                    details=details,
                    created_at=now,
                    updated_at=now,
                )
                await session.insert_alert(current)
            elif current.status == "firing" and not fact.recovered:
                current.details = details
                await session.save_alert(current)
                return current
            else:
                current.details = details
                current.summary = summary
                await session.save_alert(current)
        body = {
            "dedupKey": key,
            "tenantId": fact.tenant_id,
            "productionId": fact.production_id,
            "stage": fact.stage,
            "errorCode": fact.error_code,
            "kind": fact.kind,
            "summary": summary,
            "details": details,
        }
        try:
            if fact.recovered:
                await self._channel.resolve(key)
                status = "resolved"
            else:
                await self._channel.publish(body)
                status = "firing"
            error = None
        except Exception as exc:
            status = "channel_failed"
            error = type(exc).__name__
        async with self._ledger.transaction() as session:
            saved = await session.get_alert(key)
            if saved is None:
                raise KeyError(key)
            saved.status = status
            if error:
                saved.details = {**saved.details, "channelError": error}
            await session.save_alert(saved)
            return saved


def dedup_key(
    *,
    tenant_id: str,
    production_id: str | None,
    stage: str,
    error_code: str,
    window_start: datetime,
) -> str:
    return "|".join(
        (
            tenant_id,
            production_id or "-",
            stage,
            error_code,
            window_start.replace(microsecond=0).isoformat(),
        )
    )


def sanitize(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(value, str):
        if _URL.search(value) or "sig=" in value or "?" in value:
            return "[redacted-url]"
        if len(value) > 180:
            return "[redacted]"
        return value
    if isinstance(value, dict):
        if "items" in value and "shots" in value:
            return "[redacted-project]"
        cleaned = {}
        for key, item in value.items():
            if _SECRET.search(str(key)) or key in {"text", "dialogue", "project", "lines"}:
                cleaned[str(key)] = "[redacted]"
            else:
                cleaned[str(key)] = sanitize(item, depth=depth + 1)
        return cleaned
    if isinstance(value, list):
        return [sanitize(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return "[redacted]"


def window_start(moment: datetime) -> datetime:
    minutes = int(_WINDOW.total_seconds() // 60)
    return moment - timedelta(
        minutes=moment.minute % minutes,
        seconds=moment.second,
        microseconds=moment.microsecond,
    )
