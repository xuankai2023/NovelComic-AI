"""Preview, review, and the single fixing round. Rendering stays with the render worker."""

from __future__ import annotations

import hashlib
from typing import Any

from ..analyzer.image_fetcher import ImageFetcher
from ..canonical import hash_content
from ..contracts.errors import ComicServiceError
from ..contracts.fix_plan import FixPlan
from ..drafts.apply_compose_command import ComposeCommandApplier
from ..operations.tenant_policy import TenantDirectory, auth_context, evaluate, quota_facts
from ..persistence.rows import ProductionRow
from ..qa.binding import require_draft_binding
from ..qa.contact_sheet import assemble_contact_sheet, decode_png, write_preview_avi
from ..qa.fix_policy import FixPolicy
from ..qa.reviewer import Reviewer, ReviewRequest
from ..rendering.remotion_client import ContactFrame, RenderingGateway, StillFrame
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionNotFoundError, ProductionRepository
from ..storage.key_layout import preview_object_key
from ..storage.object_store import ObjectStore
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import ProductionState
from .stage_commit import commit_stage

_STATES = {ProductionState.PREVIEWING, ProductionState.REVIEWING, ProductionState.FIXING}


class PreviewWorker:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        artifacts: ArtifactRepository,
        objects: ObjectStore,
        remotion: RenderingGateway,
        applier: ComposeCommandApplier,
        reviewer: Reviewer,
        fix_policy: FixPolicy,
        directory: TenantDirectory,
        fetcher: ImageFetcher | None = None,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._artifacts = artifacts
        self._objects = objects
        self._remotion = remotion
        self._applier = applier
        self._reviewer = reviewer
        self._fix_policy = fix_policy
        self._directory = directory
        self._fetcher = fetcher

    async def run(self, production_id: str) -> ProductionSnapshot:
        for _ in range(8):
            row = await self._productions.get_row(production_id)
            state = ProductionState(row.state)
            if state not in _STATES:
                return await self._productions.get(production_id)
            feature = "preview" if state is ProductionState.PREVIEWING else "review"
            if not self._permitted(row, feature):
                await self._productions.record_error(
                    production_id,
                    code="STAGE_GUARD_REJECTED",
                    message="tenant policy rejected the stage",
                )
                return await self._productions.get(production_id)
            try:
                if state is ProductionState.PREVIEWING:
                    if not await self._preview(row):
                        return await self._productions.get(production_id)
                elif state is ProductionState.REVIEWING:
                    await self._review(row)
                else:
                    await self._fix(row)
            except ComicServiceError as exc:
                await self._productions.record_error(
                    production_id,
                    code=exc.code,
                    message=exc.body.message,
                )
                if exc.code == "JOB_LEASE_CONFLICT":
                    continue
                return await self._productions.get(production_id)
        return await self._productions.get(production_id)

    async def contact_sheet(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        row, draft = await self._bound(tenant_id, production_id, revision, content_hash)
        frames = await self._remotion.contact_sheet(draft.project)
        current = await self._drafts.get(row.project_id)
        require_draft_binding(current, revision=revision, content_hash=content_hash)
        return {
            "productionId": production_id,
            "revision": revision,
            "contentHash": content_hash,
            "frames": [{"shotId": frame.shot_id, "frame": frame.frame} for frame in frames],
        }

    async def preview(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> dict[str, Any]:
        row, draft = await self._bound(tenant_id, production_id, revision, content_hash)
        frames = await self._remotion.contact_sheet(draft.project)
        stills = []
        for frame in frames:
            stills.append(await self._still(row, content_hash, frame))
        current = await self._drafts.get(row.project_id)
        require_draft_binding(current, revision=revision, content_hash=content_hash)
        sheet_key = await self._store_bytes(
            row,
            content_hash,
            kind="contact-sheet",
            body=assemble_contact_sheet(stills),
            content_type="image/png",
            frames=frames,
        )
        lowres_key = await self._store_bytes(
            row,
            content_hash,
            kind="lowres-preview",
            body=write_preview_avi(stills),
            content_type="video/avi",
            frames=frames,
        )
        return {
            "productionId": production_id,
            "revision": revision,
            "contentHash": content_hash,
            "contactSheetKey": sheet_key,
            "lowresKey": lowres_key,
        }

    async def _preview(self, row: ProductionRow) -> bool:
        draft = await self._drafts.get(row.project_id)
        frames = await self._remotion.contact_sheet(draft.project)
        stills: list[bytes] = []
        failed = False
        for frame in frames:
            try:
                stills.append(await self._still(row, draft.content_hash, frame))
            except ComicServiceError as exc:
                if not exc.body.retryable:
                    raise
                failed = True
        current = await self._drafts.get(row.project_id)
        if current.content_hash != draft.content_hash or current.revision != draft.revision:
            return False
        if failed or len(stills) != len(frames):
            await self._productions.record_error(
                row.production_id,
                code="COMPOSE_FAILED",
                message="preview still failed",
            )
            return False
        sheet = assemble_contact_sheet(stills)
        if not sheet.startswith(b"\x89PNG") or sheet[:1] in {b"{", b"["}:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "contact sheet is not an image",
                retryable=False,
            )
        reel = write_preview_avi(stills)
        if not reel.startswith(b"RIFF"):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "low-resolution preview is not a video",
                retryable=False,
            )
        sheet_key = await self._store_bytes(
            row,
            draft.content_hash,
            kind="contact-sheet",
            body=sheet,
            content_type="image/png",
            frames=frames,
        )
        lowres_key = await self._store_bytes(
            row,
            draft.content_hash,
            kind="lowres-preview",
            body=reel,
            content_type="video/avi",
            frames=frames,
        )
        sheet_ready = await self._objects.head(sheet_key) is not None
        reel_ready = await self._objects.head(lowres_key) is not None
        if not sheet_ready or not reel_ready:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview artifact is not readable",
                retryable=True,
            )
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.PREVIEWING,
            {
                "contentHash": draft.content_hash,
                "revision": draft.revision,
                "frames": [{"shotId": frame.shot_id, "frame": frame.frame} for frame in frames],
                "contactSheetKey": sheet_key,
                "lowresKey": lowres_key,
            },
            can_produce_playable=True,
            degraded=row.degraded,
        )
        return True

    async def _review(self, row: ProductionRow) -> None:
        draft = await self._drafts.get(row.project_id)
        fact = row.stage_facts.get("PREVIEWING") or {}
        if fact.get("contentHash") != draft.content_hash:
            await self._productions.record_error(
                row.production_id,
                code="DRAFT_REVISION_CONFLICT",
                message="preview is not bound to the committed content hash",
            )
            return
        summary = await self._remotion.summarize_project(draft.project)
        request = ReviewRequest(
            content_hash=str(fact["contentHash"]),
            draft_content_hash=draft.content_hash,
            frames=tuple(fact.get("frames") or []),
            summary=summary,
            still_keys=(str(fact.get("contactSheetKey") or ""),),
            lowres_key=fact.get("lowresKey"),
        )
        try:
            report = await self._reviewer.review(request)
        except ComicServiceError as exc:
            if exc.body.message != "reviewer unavailable":
                raise
            await self._advance_review(
                row,
                draft.content_hash,
                {"reviewSkipped": True, "reason": "reviewer-unavailable"},
                degraded=True,
            )
            return
        report_key = await self._store_bytes(
            row,
            draft.content_hash,
            kind="review-report",
            body=report.model_dump_json(by_alias=True).encode(),
            content_type="application/json",
            frames=[],
        )
        report = report.model_copy(update={"raw_artifact_key": report_key})
        if "auto-fix" not in self._directory.features:
            plan = FixPlan(
                decision="rejected",
                reason="feature-disabled",
                expected_revision=draft.revision,
                estimated_cost_fen=0,
                content_hash=draft.content_hash,
            )
        else:
            plan = self._fix_policy.decide(
                report=report,
                project=draft.project,
                project_id=row.project_id,
                revision=draft.revision,
                fixing_count=row.fixing_count,
            )
        if (
            plan.decision == "approved"
            and plan.expected_revision == draft.revision
            and plan.content_hash == draft.content_hash
            and plan.estimated_cost_fen == 0
        ):
            await self._productions.advance(
                production_id=row.production_id,
                expected_state=ProductionState.REVIEWING,
                expected_version=row.version,
                next_state=ProductionState.FIXING,
                completion_fact={
                    "contentHash": draft.content_hash,
                    "plan": plan.model_dump(mode="json", by_alias=True),
                    "reportKey": report_key,
                },
                can_produce_playable=True,
                degraded=row.degraded,
            )
            return
        await self._advance_review(
            row,
            draft.content_hash,
            {
                "reason": plan.reason,
                "issueCount": len(report.issues),
                "reportKey": report_key,
            },
            degraded=row.degraded or bool(report.issues) or plan.reason != "no-actionable-issue",
        )

    async def _fix(self, row: ProductionRow) -> None:
        draft = await self._drafts.get(row.project_id)
        raw_plan = (row.stage_facts.get("REVIEWING") or {}).get("plan")
        plan = FixPlan.model_validate(raw_plan) if isinstance(raw_plan, dict) else None
        if (
            plan is None
            or plan.decision != "approved"
            or draft.revision != plan.expected_revision
            or draft.content_hash != plan.content_hash
        ):
            await commit_stage(
                self._productions,
                row.production_id,
                ProductionState.FIXING,
                {"voided": True, "contentHash": draft.content_hash},
                can_produce_playable=True,
                degraded=True,
            )
            return
        for command in plan.commands:
            allowed = {"shot/edit", "item/motion", "layers/restore-l0", "dialogue/add"}
            if command.name not in allowed:
                raise ComicServiceError(
                    "STAGE_GUARD_REJECTED",
                    "fix command is not on the allowlist",
                    retryable=False,
                )
            try:
                await self._applier.apply(command)
            except ComicServiceError as exc:
                if exc.code != "DRAFT_REVISION_CONFLICT":
                    raise
                fresh = await self._drafts.get(row.project_id)
                await commit_stage(
                    self._productions,
                    row.production_id,
                    ProductionState.FIXING,
                    {"voided": True, "contentHash": fresh.content_hash},
                    can_produce_playable=True,
                    degraded=True,
                )
                return
        fresh = await self._drafts.get(row.project_id)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.FIXING,
            {
                "applied": [command.command_id for command in plan.commands],
                "contentHash": fresh.content_hash,
                "revision": fresh.revision,
            },
            can_produce_playable=True,
            degraded=row.degraded,
        )

    async def _still(self, row: ProductionRow, content_hash: str, frame: ContactFrame) -> bytes:
        identity = hash_content(
            {
                "contentHash": content_hash,
                "frame": frame.frame,
                "kind": "still",
                "shotId": frame.shot_id,
            }
        )
        claim = await self._artifacts.claim(
            tenant_id=row.tenant_id,
            project_id=row.project_id,
            stage="preview",
            input_hash=identity,
            artifact_id=f"still:{row.production_id}:{identity[:16]}",
            provider="remotion-preview",
            shot_id=frame.shot_id,
        )
        if claim.artifact.status == "completed":
            key = claim.artifact.diagnostics.get("objectKey")
            checksums = claim.artifact.checksums
            matches = isinstance(key, str) and await self._objects.checksum(key) == checksums[0]
            if matches:
                return await self._objects.get(key)
        if not claim.start_work:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview still is still running",
                retryable=True,
            )
        draft = await self._drafts.get(row.project_id)
        if draft.content_hash != content_hash:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "preview frame is not bound to the committed content hash",
                retryable=False,
            )
        try:
            rendered = await self._remotion.preview_frame(
                draft.project, frame=frame.frame, width=480
            )
            body = await self._body(rendered)
            decode_png(body)
        except ComicServiceError:
            await self._artifacts.fail(claim.artifact.artifact_id, diagnostics={"failed": True})
            raise
        except Exception as exc:
            await self._artifacts.fail(claim.artifact.artifact_id, diagnostics={"failed": True})
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview still failed",
                retryable=True,
            ) from exc
        digest = hashlib.sha256(body).hexdigest()
        key = preview_object_key(
            tenant_id=row.tenant_id,
            production_id=row.production_id,
            name=f"still-{digest[:16]}",
            checksum=digest,
        )
        stored = await self._objects.put_verified(key, body, content_type="image/png")
        if stored != digest:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview still checksum mismatch",
                retryable=True,
            )
        await self._artifacts.complete(
            claim.artifact.artifact_id,
            urls=[self._objects.stable_url(key)],
            checksums=[digest],
            diagnostics={
                "objectKey": key,
                "contentHash": content_hash,
                "kind": "still",
                "frame": frame.frame,
            },
            cost_fen=0,
        )
        return body

    async def _store_bytes(
        self,
        row: ProductionRow,
        content_hash: str,
        *,
        kind: str,
        body: bytes,
        content_type: str,
        frames: list[ContactFrame],
    ) -> str:
        digest = hashlib.sha256(body).hexdigest()
        identity = hash_content({"contentHash": content_hash, "kind": kind})
        claim = await self._artifacts.claim(
            tenant_id=row.tenant_id,
            project_id=row.project_id,
            stage="preview",
            input_hash=identity,
            artifact_id=f"{kind}:{row.production_id}:{identity[:16]}",
            provider="remotion-preview",
        )
        key = preview_object_key(
            tenant_id=row.tenant_id,
            production_id=row.production_id,
            name=f"{kind}-{digest[:16]}",
            checksum=digest,
        )
        if claim.artifact.status == "completed" and claim.artifact.checksums == [digest]:
            existing = claim.artifact.diagnostics.get("objectKey")
            if isinstance(existing, str) and await self._objects.head(existing) is not None:
                return existing
        if not claim.start_work and claim.artifact.status != "completed":
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview artifact is still running",
                retryable=True,
            )
        stored = await self._objects.put_verified(key, body, content_type=content_type)
        if stored != digest or await self._objects.checksum(key) != digest:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview artifact checksum mismatch",
                retryable=True,
            )
        if claim.artifact.status != "completed":
            await self._artifacts.complete(
                claim.artifact.artifact_id,
                urls=[self._objects.stable_url(key)],
                checksums=[digest],
                diagnostics={
                    "objectKey": key,
                    "contentHash": content_hash,
                    "kind": kind,
                    "frames": [{"shotId": frame.shot_id, "frame": frame.frame} for frame in frames],
                },
                cost_fen=0,
            )
        return key

    async def _body(self, rendered: StillFrame) -> bytes:
        if rendered.body:
            return rendered.body
        if rendered.url and self._fetcher is not None:
            return await self._fetcher.fetch(rendered.url)
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "preview frame has no image",
            retryable=True,
            details={"taskId": rendered.task_id},
        )

    async def _bound(
        self,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> tuple[ProductionRow, Any]:
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        if not self._permitted(row, "preview"):
            raise ComicServiceError("STAGE_GUARD_REJECTED", "feature-disabled", retryable=False)
        draft = await self._drafts.get_revision(row.project_id, revision)
        require_draft_binding(draft, revision=revision, content_hash=content_hash)
        return row, draft

    def _permitted(self, row: ProductionRow, feature: str) -> bool:
        decision = evaluate(
            auth_context(self._directory, row.tenant_id),
            resource_tenant_id=row.tenant_id,
            facts=quota_facts(self._directory),
            feature=feature,
        )
        if decision.allowed:
            return True
        return False

    async def _advance_review(
        self,
        row: ProductionRow,
        content_hash: str,
        fact: dict[str, Any],
        *,
        degraded: bool,
    ) -> None:
        await self._productions.advance(
            production_id=row.production_id,
            expected_state=ProductionState.REVIEWING,
            expected_version=row.version,
            next_state=ProductionState.PLANNING_BATCHES,
            completion_fact={"contentHash": content_hash, **fact},
            can_produce_playable=True,
            degraded=degraded,
        )
