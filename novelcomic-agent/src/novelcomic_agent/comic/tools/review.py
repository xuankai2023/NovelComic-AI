"""Review tools rerun analysis. They do not approve or apply a fix."""

from __future__ import annotations

from typing import Any

from ..contracts.errors import ComicServiceError
from ..operations.tenant_policy import TenantDirectory, auth_context, evaluate, quota_facts
from ..qa.binding import require_draft_binding
from ..qa.reviewer import Reviewer, ReviewRequest
from ..rendering.remotion_client import RenderingGateway
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionNotFoundError, ProductionRepository
from ..workers.preview_worker import PreviewWorker


class ReviewTools:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        remotion: RenderingGateway,
        reviewer: Reviewer,
        preview: PreviewWorker,
        directory: TenantDirectory,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._remotion = remotion
        self._reviewer = reviewer
        self._preview = preview
        self._directory = directory

    async def analyze(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        row = await self._require(tenant_id, production_id, "review")
        draft = await self._drafts.get_revision(row.project_id, revision)
        require_draft_binding(draft, revision=revision, content_hash=content_hash)
        current = await self._drafts.get(row.project_id)
        require_draft_binding(current, revision=revision, content_hash=content_hash)
        fact = row.stage_facts.get("PREVIEWING") or {}
        if fact.get("contentHash") != content_hash:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "preview is not bound to the committed content hash",
                retryable=False,
            )
        summary = await self._remotion.summarize_project(draft.project)
        report = await self._reviewer.review(
            ReviewRequest(
                content_hash=content_hash,
                draft_content_hash=current.content_hash,
                frames=tuple(fact.get("frames") or []),
                summary=summary,
                still_keys=(str(fact.get("contactSheetKey") or ""),),
                lowres_key=fact.get("lowresKey"),
            )
        )
        return report.model_dump(mode="json", by_alias=True)

    async def contact_sheet(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        return await self._preview.contact_sheet(
            tenant_id=tenant_id,
            production_id=production_id,
            revision=revision,
            content_hash=content_hash,
        )

    async def preview(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        return await self._preview.preview(
            tenant_id=tenant_id,
            production_id=production_id,
            revision=revision,
            content_hash=content_hash,
        )

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
