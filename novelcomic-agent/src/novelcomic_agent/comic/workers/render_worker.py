"""Compose the L0 project, validate it, and render only missing batches."""

from __future__ import annotations

import hashlib
from typing import Any

from ..analyzer.image_fetcher import ImageFetcher
from ..assets.l0_panel import committed_panel_fit_applied, l0_project_payload
from ..contracts.errors import ComicServiceError
from ..contracts.timed_shot_spec import TimedShotSpec
from ..drafts.apply_compose_command import ComposeCommandApplier
from ..persistence.rows import BatchRow, ProductionRow, utcnow
from ..rendering.commands import compose_command
from ..rendering.dialogue_payload import dialogue_and_voice_payloads
from ..rendering.remotion_client import RenderingGateway
from ..repositories.cost_repository import CostRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import (
    ProductionNotFoundError,
    ProductionRepository,
    load_request,
)
from ..repositories.render_repository import RenderRepository
from ..storage.key_layout import render_object_key
from ..storage.object_store import ObjectStore
from ..units import MIN_PROJECT_FRAMES
from ..workflow.cost_budget import CostReservation
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import TERMINAL_STATES, ProductionState
from .stage_commit import commit_stage

_RENDER_STATES = {
    ProductionState.PREPARING_ASSETS,
    ProductionState.COMPOSING,
    ProductionState.VALIDATING,
    ProductionState.PLANNING_BATCHES,
    ProductionState.RENDERING_BATCHES,
}


class RenderWorker:
    """Stage B treats analyzer crops as the L0 plate and renders that project."""

    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        renders: RenderRepository,
        costs: CostRepository,
        objects: ObjectStore,
        remotion: RenderingGateway,
        applier: ComposeCommandApplier,
        render_worst_case_fen: int,
        fetcher: ImageFetcher | None = None,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._renders = renders
        self._costs = costs
        self._objects = objects
        self._remotion = remotion
        self._applier = applier
        self._render_worst_case_fen = render_worst_case_fen
        self._fetcher = fetcher

    async def run(self, production_id: str) -> ProductionSnapshot:
        for _ in range(12):
            row = await self._productions.get_row(production_id)
            state = ProductionState(row.state)
            if state in TERMINAL_STATES or state not in _RENDER_STATES:
                return await self._productions.get(production_id)
            try:
                if state is ProductionState.PREPARING_ASSETS:
                    await self._prepare(row)
                elif state is ProductionState.COMPOSING:
                    await self._compose(row)
                elif state is ProductionState.VALIDATING:
                    await self._validate(row)
                elif state is ProductionState.PLANNING_BATCHES:
                    await self._plan(row)
                else:
                    if not await self._render(row):
                        return await self._productions.get(production_id)
            except ComicServiceError as exc:
                await self._productions.record_error(
                    production_id,
                    code=exc.code,
                    message=exc.body.message,
                )
                if exc.code == "JOB_LEASE_CONFLICT":
                    continue
                if exc.body.retryable:
                    raise
                return await self._productions.get(production_id)
        return await self._productions.get(production_id)

    async def retry_failed(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
        force: bool = False,
    ) -> ProductionSnapshot:
        """Ops retry. Force still cannot pass a cancelled production or a live render id."""

        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        self._require_billable(row)
        draft = await self._drafts.get_revision(row.project_id, revision)
        if draft.content_hash != content_hash:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "batch retry is not bound to the committed content hash",
                retryable=False,
            )
        batches = await self._renders.list_for_hash(row.project_id, content_hash)
        targets = [
            batch
            for batch in batches
            if not batch.render_id
            and (batch.status == "failed" or (force and batch.status == "pending"))
        ]
        await self._submit_many(row, draft.project, targets)
        return await self._productions.get(production_id)

    async def plan_bound(
        self,
        *,
        tenant_id: str,
        production_id: str,
        revision: int,
        content_hash: str,
    ) -> list[dict[str, Any]]:
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        self._require_billable(row)
        draft = await self._drafts.get_revision(row.project_id, revision)
        if draft.content_hash != content_hash:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "batch plan is not bound to the committed content hash",
                retryable=False,
            )
        if ProductionState(row.state) is ProductionState.PLANNING_BATCHES:
            await self._plan(row)
        batches = await self._renders.list_for_hash(row.project_id, content_hash)
        return [batch.render_config for batch in batches]

    async def _prepare(self, row: ProductionRow) -> None:
        request = load_request(row)
        shots = _shots(row)
        draft = await self._drafts.get(row.project_id)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.PREPARING_ASSETS,
            _fit_fact(
                request.output.panel_fit_policy,
                committed_panel_fit_applied(draft.project, [shot.shot_id for shot in shots]),
                extra={"level": "L0", "shotCount": len(shots)},
            ),
            can_produce_playable=True,
            degraded=row.degraded,
        )

    async def _compose(self, row: ProductionRow) -> None:
        request = load_request(row)
        shots = _shots(row)
        await self._apply(
            row.project_id,
            "image/sequence",
            l0_project_payload(
                row.stage_facts,
                shots,
                fallback_width=request.output.width,
                fallback_height=request.output.height,
            ),
        )
        draft = await self._drafts.get(row.project_id)
        placed = {shot["id"]: shot for shot in draft.project.get("shots") or []}
        dialogue, voice = dialogue_and_voice_payloads(
            shots,
            placed,
            subtitle_mode=request.style.subtitle_mode,
        )
        if dialogue is not None:
            await self._apply(row.project_id, "dialogue/add", dialogue)
        if voice is not None:
            await self._apply(row.project_id, "dialogue/voice", voice)
        draft = await self._drafts.get(row.project_id)
        total = _project_frames(draft.project)
        if total < MIN_PROJECT_FRAMES:
            await self._apply(
                row.project_id,
                "project/pad",
                {"minimumDurationInFrames": MIN_PROJECT_FRAMES},
            )
            draft = await self._drafts.get(row.project_id)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.COMPOSING,
            _fit_fact(
                request.output.panel_fit_policy,
                committed_panel_fit_applied(draft.project, [shot.shot_id for shot in shots]),
                extra={"contentHash": draft.content_hash, "revision": draft.revision},
            ),
            can_produce_playable=True,
            degraded=row.degraded,
        )

    async def _validate(self, row: ProductionRow) -> None:
        draft = await self._drafts.get(row.project_id)
        report = await self._remotion.validate_project(draft.project)
        if not report.valid:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "committed project failed validation",
                retryable=True,
                details={"issues": list(report.issues)},
            )
        summary = await self._remotion.summarize_project(draft.project)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.VALIDATING,
            {"valid": True, "contentHash": draft.content_hash, "summary": summary},
            can_produce_playable=True,
            degraded=row.degraded,
        )

    async def _plan(self, row: ProductionRow) -> None:
        draft = await self._drafts.get(row.project_id)
        planned = await self._remotion.plan_batches(draft.project)
        if not planned:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "render planning returned no batches",
                retryable=True,
            )
        await self._renders.cancel_other_hashes(row.project_id, draft.content_hash)
        batch_ids: list[str] = []
        for batch in planned:
            saved = await self._renders.save_planned(
                _batch_row(row.project_id, draft.content_hash, batch)
            )
            batch_ids.append(saved.batch_id)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.PLANNING_BATCHES,
            {"contentHash": draft.content_hash, "batchIds": batch_ids},
            can_produce_playable=True,
            degraded=row.degraded,
        )

    async def _render(self, row: ProductionRow) -> bool:
        self._require_billable(row)
        content_hash = row.stage_facts["PLANNING_BATCHES"]["contentHash"]
        draft = await self._drafts.get(row.project_id)
        if draft.content_hash != content_hash:
            await self._renders.cancel_other_hashes(row.project_id, draft.content_hash)
            planned = await self._remotion.plan_batches(draft.project)
            for batch in planned:
                await self._renders.save_planned(
                    _batch_row(row.project_id, draft.content_hash, batch)
                )
            content_hash = draft.content_hash
        batches = await self._renders.list_for_hash(row.project_id, content_hash)
        await self._submit_many(row, draft.project, batches)
        if not await self._renders.required_complete(row.project_id, content_hash):
            return False
        completed = await self._renders.list_for_hash(row.project_id, content_hash)
        await commit_stage(
            self._productions,
            row.production_id,
            ProductionState.RENDERING_BATCHES,
            {
                "contentHash": content_hash,
                "batches": [
                    {
                        "batchId": batch.batch_id,
                        "checksum": batch.checksum,
                        "objectKey": batch.object_key,
                    }
                    for batch in completed
                    if batch.required
                ],
            },
            can_produce_playable=True,
            degraded=row.degraded,
        )
        return True

    async def _submit_many(
        self,
        row: ProductionRow,
        project: dict[str, Any],
        batches: list[BatchRow],
    ) -> None:
        for batch in batches:
            if batch.status == "completed":
                continue
            if batch.render_id:
                await self._poll(row, batch)
                continue
            if batch.status not in {"pending", "failed"}:
                continue
            if batch.attempt >= 3:
                await self._productions.record_error(
                    row.production_id,
                    code="COMPOSE_FAILED",
                    message=f"render batch {batch.batch_id} exhausted retries",
                )
                continue
            self._require_billable(row)
            reserved = await self._costs.reserve_operation(
                CostReservation(
                    reservation_id=f"render:{row.production_id}:{batch.batch_id}:{batch.content_hash[:16]}",
                    production_id=row.production_id,
                    worst_case_fen=self._render_worst_case_fen,
                ),
                provider="remotion",
            )
            if not reserved:
                raise ComicServiceError(
                    "BUDGET_EXCEEDED",
                    "render reservation was rejected",
                    retryable=False,
                )
            results = await self._remotion.render_batches(
                project,
                retry_batch_ids=[batch.batch_id],
            )
            match = next((item for item in results if item.get("batchId") == batch.batch_id), None)
            if match is None or not match.get("ok"):
                await self._renders.mark_failed(batch.output_batch_render_id)
                await self._costs.release(
                    f"render:{row.production_id}:{batch.batch_id}:{batch.content_hash[:16]}"
                )
                continue
            submitted = await self._renders.mark_submitted(
                batch.output_batch_render_id,
                render_id=str(match["renderId"]),
                bucket_name=str(match["bucketName"]),
            )
            current = submitted or batch
            if submitted is None:
                current = await self._current_batch(batch)
            await self._poll(row, current)

    async def _poll(self, row: ProductionRow, batch: BatchRow) -> None:
        if not batch.render_id or not batch.bucket_name:
            return
        progress = await self._remotion.render_progress(
            bucket_name=batch.bucket_name,
            render_id=batch.render_id,
        )
        if progress.status == "in-progress":
            await self._renders.save_progress(
                batch.output_batch_render_id,
                progress=progress.progress,
                status="rendering",
            )
            return
        if progress.status == "error":
            await self._renders.mark_failed(batch.output_batch_render_id)
            return
        body = progress.output_bytes
        if body is None and progress.output_url and self._fetcher is not None:
            body = await self._fetcher.fetch(progress.output_url)
        if body is None:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "render finished without output bytes",
                retryable=True,
            )
        digest = hashlib.sha256(body).hexdigest()
        key = render_object_key(
            tenant_id=row.tenant_id,
            production_id=row.production_id,
            batch_id=hashlib.sha256(batch.batch_id.encode()).hexdigest(),
            checksum=digest,
        )
        stored = await self._objects.put_verified(key, body, content_type="video/mp4")
        confirmed = await self._objects.checksum(key)
        if stored != digest or confirmed != digest:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "render output checksum mismatch",
                retryable=True,
            )
        await self._renders.mark_completed(
            batch.output_batch_render_id,
            url=self._objects.stable_url(key),
            checksum=digest,
            object_key=key,
        )
        await self._costs.settle(
            f"render:{row.production_id}:{batch.batch_id}:{batch.content_hash[:16]}",
            progress.actual_cost_fen or 0,
        )

    async def _current_batch(self, batch: BatchRow) -> BatchRow:
        rows = await self._renders.list_for_hash(batch.project_id, batch.content_hash)
        for row in rows:
            if row.output_batch_render_id == batch.output_batch_render_id:
                return row
        return batch

    async def _apply(self, project_id: str, name: str, payload: dict[str, Any]) -> None:
        command = compose_command(project_id, name, payload)
        try:
            await self._applier.apply(command)
        except ComicServiceError as exc:
            if exc.code != "DRAFT_REVISION_CONFLICT":
                raise
            await self._applier.apply(command)

    def _require_billable(self, row: ProductionRow) -> None:
        if row.cancel_requested_at is not None or row.state == ProductionState.CANCELLED.value:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "production is cancelled",
                retryable=False,
            )


def _fit_fact(
    policy: str,
    applied: bool,
    *,
    extra: dict[str, Any],
) -> dict[str, Any]:
    fact: dict[str, Any] = {
        "panelFitPolicy": policy,
        "panelFitApplied": applied,
        **extra,
    }
    if not applied:
        fact["panelFitReason"] = "committed project is missing blurred-background layers"
    return fact


def _shots(row: ProductionRow) -> list[TimedShotSpec]:
    payload = row.stage_facts["SYNTHESIZING_VOICE"]["shots"]
    return [TimedShotSpec.model_validate(item) for item in payload]


def _project_frames(project: dict[str, Any]) -> int:
    return sum(int(shot["durationInFrames"]) for shot in project.get("shots") or [])


def _batch_row(project_id: str, content_hash: str, batch: dict[str, Any]) -> BatchRow:
    now = utcnow()
    frame_from = int(batch["fromFrame"])
    frame_to = int(batch["endFrameInclusive"]) + 1
    batch_id = str(batch["batchId"])
    return BatchRow(
        output_batch_render_id=f"obr:{project_id}:{batch_id}:{content_hash[:16]}",
        project_id=project_id,
        batch_id=batch_id,
        content_hash=content_hash,
        render_id=None,
        bucket_name=None,
        status="pending",
        url=None,
        checksum=None,
        object_key=None,
        frame_from=frame_from,
        frame_to=frame_to,
        progress=0,
        attempt=0,
        shot_ids=list(batch.get("shotIds") or []),
        required=True,
        render_config=batch,
        created_at=now,
        updated_at=now,
    )
