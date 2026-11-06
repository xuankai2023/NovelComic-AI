"""Package job enqueue and tenant-scoped delivery reads."""

from __future__ import annotations

from ..persistence.ledger import Ledger
from ..persistence.rows import DeliveryRow, JobRow, utcnow


class DeliveryRepository:
    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def find(self, production_id: str, package_input_hash: str) -> DeliveryRow | None:
        async with self._ledger.transaction() as session:
            return await session.find_delivery(production_id, package_input_hash)

    async def list_for_tenant(self, tenant_id: str, production_id: str) -> list[DeliveryRow]:
        async with self._ledger.transaction() as session:
            rows = await session.list_deliveries(production_id)
        return [row for row in rows if row.tenant_id == tenant_id]

    async def references(self, tenant_id: str, object_key: str) -> bool:
        async with self._ledger.transaction() as session:
            rows = await session.list_deliveries()
        for row in rows:
            if row.tenant_id != tenant_id or row.status != "active":
                continue
            if row.object_key == object_key:
                return True
            for item in row.manifest_json.get("files") or []:
                if item.get("objectKey") == object_key:
                    return True
        return False

    async def revoke(self, tenant_id: str, delivery_id: str) -> DeliveryRow | None:
        async with self._ledger.transaction() as session:
            rows = await session.list_deliveries()
            row = next((item for item in rows if item.delivery_id == delivery_id), None)
            if row is None or row.tenant_id != tenant_id:
                return None
            if row.status == "revoked":
                return row
            row.status = "revoked"
            row.url_generation += 1
            row.revoked_at = utcnow()
            await session.save_delivery(row)
            return row

    async def enqueue_package(
        self,
        *,
        tenant_id: str,
        production_id: str,
        content_hash: str,
        revision: int,
    ) -> tuple[JobRow, bool]:
        job_key = f"package:{tenant_id}:{production_id}:{content_hash}"
        now = utcnow()
        async with self._ledger.transaction() as session:
            existing = await session.get_job(job_key)
            if existing is not None:
                return existing, False
            row = JobRow(
                job_key=job_key,
                type="package",
                payload={
                    "tenantId": tenant_id,
                    "productionId": production_id,
                    "contentHash": content_hash,
                    "revision": revision,
                },
                status="pending",
                attempt=0,
                lease_owner=None,
                lease_expires_at=None,
                heartbeat_at=None,
                last_error_code=None,
                created_at=now,
                updated_at=now,
            )
            await session.insert_job(row)
            return row, True
