"""Package enqueue and delivery lookup. The ZIP is built by the package worker."""

from __future__ import annotations

from typing import Any

from ..contracts.errors import ComicServiceError
from ..operations.tenant_policy import TenantDirectory, auth_context, evaluate, quota_facts
from ..qa.binding import require_draft_binding
from ..repositories.delivery_repository import DeliveryRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionNotFoundError, ProductionRepository
from ..storage.object_store import ObjectStore


class DeliveryTools:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        deliveries: DeliveryRepository,
        objects: ObjectStore,
        directory: TenantDirectory,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._deliveries = deliveries
        self._objects = objects
        self._directory = directory

    async def package(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        row = await self._require(tenant_id, production_id, "package")
        draft = await self._drafts.get_revision(row.project_id, revision)
        require_draft_binding(draft, revision=revision, content_hash=content_hash)
        current = await self._drafts.get(row.project_id)
        require_draft_binding(current, revision=revision, content_hash=content_hash)
        job, created = await self._deliveries.enqueue_package(
            tenant_id=tenant_id,
            production_id=production_id,
            content_hash=content_hash,
            revision=revision,
        )
        return {
            "productionId": production_id,
            "jobKey": job.job_key,
            "status": job.status,
            "created": created,
            "contentHash": content_hash,
        }

    async def delivery(
        self,
        *,
        tenant_id: str,
        production_id: str,
    ) -> dict[str, Any]:
        row = await self._require(tenant_id, production_id, "delivery")
        rows = await self._deliveries.list_for_tenant(tenant_id, production_id)
        if not rows:
            return {"productionId": row.production_id, "state": row.state, "delivery": None}
        current = next((item for item in reversed(rows) if item.status == "active"), rows[-1])
        payload: dict[str, Any] = {
            "productionId": row.production_id,
            "state": row.state,
            "status": current.status,
            "checksum": current.checksum,
            "sizeBytes": current.size_bytes,
            "objectKey": current.object_key,
            "playOrder": list(current.play_order),
            "manifest": current.manifest_json,
            "urlGeneration": current.url_generation,
        }
        if current.status == "active":
            signed = await self._objects.signed_url(current.object_key, expires_in=900)
            payload["url"] = f"{signed}&generation={current.url_generation}"
        return payload

    async def _require(self, tenant_id: str, production_id: str, feature: str):
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        decision = evaluate(
            auth_context(self._directory, tenant_id),
            resource_tenant_id=row.tenant_id,
            facts=quota_facts(self._directory),
            feature=feature,
        )
        if not decision.allowed:
            code = (
                "BUDGET_EXCEEDED" if decision.reason.endswith("budget") else "STAGE_GUARD_REJECTED"
            )
            if decision.reason in {"missing-tenant", "unknown-tenant", "cross-tenant"}:
                code = "INVALID_REQUEST"
            raise ComicServiceError(code, decision.reason, retryable=False)
        return row
