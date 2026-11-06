"""Retention dates and idempotent deletion. Audit rows stay after the object is gone."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from uuid import uuid4

from ..persistence.ledger import Ledger
from ..persistence.rows import OutboxRow, TombstoneRow, utcnow
from ..storage.object_store import ObjectStore

_DAYS = {
    "source": 30,
    "panel": 30,
    "layer": 30,
    "audio": 30,
    "subtitle": 30,
    "preview": 7,
    "project": 30,
    "manifest": 90,
    "final-video": 90,
    "package": 90,
    "diagnostics": 14,
}


@dataclass(frozen=True, slots=True)
class DeleteDecision:
    allowed: bool
    reason: str
    retain_until: datetime | None


class Clock(Protocol):
    def __call__(self) -> datetime: ...


def plan_retention(
    *,
    category: str,
    delivered: bool,
    legal_hold: bool,
    now: datetime,
) -> datetime | None:
    if legal_hold:
        return None
    days = _DAYS.get(category, 14)
    if not delivered:
        days = min(days, 1 if category == "preview" else 7)
    return now + timedelta(days=days)


def decide_delete(
    *,
    legal_hold: bool,
    referenced_by_active_delivery: bool,
    retain_until: datetime | None,
    now: datetime,
) -> DeleteDecision:
    if legal_hold or retain_until is None:
        return DeleteDecision(False, "legal-hold", None)
    if referenced_by_active_delivery:
        return DeleteDecision(False, "delivery-reference", retain_until)
    if now < retain_until:
        return DeleteDecision(False, "retain-until", retain_until)
    return DeleteDecision(True, "expired", retain_until)


class RetentionService:
    """Write a tombstone and outbox first, then delete the object idempotently."""

    def __init__(
        self, ledger: Ledger, objects: ObjectStore, clock: Clock | None = None
    ) -> None:
        self._ledger = ledger
        self._objects = objects
        self._clock = clock or utcnow

    async def request_delete(
        self,
        *,
        tenant_id: str,
        object_key: str,
        category: str,
        delivered: bool,
        legal_hold: bool,
        referenced_by_active_delivery: bool,
    ) -> TombstoneRow:
        now = self._clock()
        retain_until = plan_retention(
            category=category,
            delivered=delivered,
            legal_hold=legal_hold,
            now=now,
        )
        decision = decide_delete(
            legal_hold=legal_hold,
            referenced_by_active_delivery=referenced_by_active_delivery,
            retain_until=retain_until,
            now=now if not legal_hold else now,
        )
        if legal_hold:
            decision = DeleteDecision(False, "legal-hold", None)
        async with self._ledger.transaction() as session:
            existing = await session.find_tombstone(tenant_id, object_key)
            if existing is not None and existing.status == "deleted":
                return existing
            status = "pending" if decision.allowed else "blocked"
            if existing is None:
                row = TombstoneRow(
                    tombstone_id=f"tomb:{uuid4().hex}",
                    tenant_id=tenant_id,
                    object_key=object_key,
                    category=category,
                    status=status,
                    reason=decision.reason,
                    retain_until=decision.retain_until,
                    requested_at=now,
                    deleted_at=None,
                    result=None,
                )
                await session.insert_tombstone(row)
            else:
                row = existing
                row.status = status
                row.reason = decision.reason
                row.retain_until = decision.retain_until
                await session.save_tombstone(row)
        if status == "pending":
            await session.insert_outbox(
                OutboxRow(
                    event_id=f"evt:retention:{row.tombstone_id}:{uuid4().hex[:8]}",
                    aggregate_id=row.tombstone_id,
                    type="retention.delete",
                    payload={
                        "tenantId": tenant_id,
                        "objectKey": object_key,
                        "category": category,
                    },
                    available_at=now,
                    published_at=None,
                    attempt=0,
                    lease_owner=None,
                    lease_expires_at=None,
                    created_at=now,
                )
            )
        return row

    async def refresh(
        self,
        tombstone_id: str,
        *,
        legal_hold: bool,
        referenced_by_active_delivery: bool,
    ) -> TombstoneRow | None:
        """Re-evaluate a tombstone after the clock or delivery reference changes."""

        now = self._clock()
        async with self._ledger.transaction() as session:
            row = await session.get_tombstone(tombstone_id)
            if row is None or row.status == "deleted":
                return row
            decision = decide_delete(
                legal_hold=legal_hold,
                referenced_by_active_delivery=referenced_by_active_delivery,
                retain_until=row.retain_until,
                now=now,
            )
            row.status = "pending" if decision.allowed else "blocked"
            row.reason = decision.reason
            await session.save_tombstone(row)
            return row

    async def execute(self, tombstone_id: str) -> TombstoneRow | None:
        async with self._ledger.transaction() as session:
            row = await session.get_tombstone(tombstone_id)
        if row is None or row.status != "pending":
            return row
        await self._objects.delete(row.object_key)
        if await self._objects.head(row.object_key) is not None:
            async with self._ledger.transaction() as session:
                current = await session.get_tombstone(tombstone_id)
                if current is None:
                    return None
                current.result = "object-remains"
                await session.save_tombstone(current)
                return current
        deleted_at = self._clock()
        async with self._ledger.transaction() as session:
            current = await session.get_tombstone(tombstone_id)
            if current is None:
                return None
            if current.status == "deleted":
                return current
            current.status = "deleted"
            current.deleted_at = deleted_at
            current.result = "deleted"
            await session.save_tombstone(current)
            return current
