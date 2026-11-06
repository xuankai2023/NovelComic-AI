"""Stage C L1 enhancement. A failed shot keeps its L0 plate and stays playable."""

from __future__ import annotations

from typing import Any

from ..assets.l0_panel import (
    committed_panel_fit_applied,
    composition_size,
    describe_l0_panel,
    l0_asset_retained,
    l0_plate_track_ids,
    l0_project_payload,
    register_l0_panel,
    shot_needs_l0_restore,
    shot_plates,
)
from ..assets.l1_layer_service import L1LayerService, LayerAttempt, LayerProvider
from ..assets.l2_sprite_service import SpriteProvider
from ..assets.layer_quality_gate import LayerGateThresholds
from ..assets.sprite_quality_gate import SpriteGateThresholds
from ..contracts.errors import ComicServiceError
from ..contracts.layer_package import layers_import_payload
from ..drafts.apply_compose_command import AppliedComposeCommand, ComposeCommandApplier
from ..persistence.rows import ProductionRow
from ..rendering.commands import compose_command
from ..rendering.motion_commands import SPRITE_STRATEGY_VERSION
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionRepository, load_request
from ..storage.object_store import ObjectStore
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import TERMINAL_STATES, ProductionState
from .sprite_motion import MotionApplyResult, SpriteCoordinator, SpritePreparation
from .stage_commit import commit_stage


class AssetWorker:
    """Own PREPARING_ASSETS when stage C is on. Stage B never starts this worker."""

    def __init__(
        self,
        *,
        productions: ProductionRepository,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        drafts: LedgerDraftRepository,
        applier: ComposeCommandApplier,
        provider: LayerProvider,
        allowed_hosts: frozenset[str],
        provider_name: str,
        model_version: str,
        parameter_version: str,
        worst_case_fen: int,
        thresholds: LayerGateThresholds | None = None,
        sprite_provider: SpriteProvider | None = None,
        l2_enabled: bool = False,
        l2_tenants: frozenset[str] | None = None,
        sprite_provider_name: str = "sprite-l2",
        sprite_model_version: str = "sprite-v1",
        sprite_parameter_version: str = "sprite-params-v1",
        sprite_worst_case_fen: int = 100,
        sprite_thresholds: SpriteGateThresholds | None = None,
        sprite_strategy_version: str = SPRITE_STRATEGY_VERSION,
    ) -> None:
        self._productions = productions
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._drafts = drafts
        self._applier = applier
        self._provider = provider
        self._allowed_hosts = allowed_hosts
        self._provider_name = provider_name
        self._model_version = model_version
        self._parameter_version = parameter_version
        self._worst_case_fen = worst_case_fen
        self._thresholds = thresholds or LayerGateThresholds()
        self._l2_enabled = l2_enabled
        self._l2_tenants = l2_tenants
        self._sprites = None
        if sprite_provider is not None:
            self._sprites = SpriteCoordinator(
                artifacts=artifacts,
                costs=costs,
                objects=objects,
                drafts=drafts,
                provider=sprite_provider,
                provider_name=sprite_provider_name,
                model_version=sprite_model_version,
                parameter_version=sprite_parameter_version,
                allowed_hosts=allowed_hosts,
                worst_case_fen=sprite_worst_case_fen,
                thresholds=sprite_thresholds,
                strategy_version=sprite_strategy_version,
            )

    async def run(self, production_id: str) -> ProductionSnapshot:
        row = await self._productions.get_row(production_id)
        state = ProductionState(row.state)
        if state in TERMINAL_STATES or state is not ProductionState.PREPARING_ASSETS:
            return await self._productions.get(production_id)
        if row.cancel_requested_at is not None:
            await self._productions.record_error(
                production_id,
                code="PRODUCTION_CANCELLED",
                message="production is cancelled",
            )
            return await self._productions.get(production_id)
        try:
            fact, degraded, ready = await self._enhance(row)
        except ComicServiceError as exc:
            await self._productions.record_error(
                production_id,
                code=exc.code,
                message=exc.body.message,
            )
            return await self._productions.get(production_id)
        if not ready or fact is None:
            return await self._productions.get(production_id)
        await commit_stage(
            self._productions,
            production_id,
            ProductionState.PREPARING_ASSETS,
            fact,
            can_produce_playable=True,
            degraded=degraded,
        )
        return await self._productions.get(production_id)

    async def _enhance(
        self,
        row: ProductionRow,
    ) -> tuple[dict[str, Any] | None, bool, bool]:
        request = load_request(row)
        plates = shot_plates(row.stage_facts)
        canvas_width, canvas_height = composition_size(
            row.stage_facts,
            request.output.width,
            request.output.height,
        )
        service = L1LayerService(
            artifacts=self._artifacts,
            costs=self._costs,
            objects=self._objects,
            provider=self._provider,
            tenant_id=row.tenant_id,
            production_id=row.production_id,
            project_id=row.project_id,
            provider_name=self._provider_name,
            model_version=self._model_version,
            parameter_version=self._parameter_version,
            allowed_hosts=self._allowed_hosts,
            worst_case_fen=self._worst_case_fen,
            thresholds=self._thresholds,
        )
        prepared: list[tuple[Any, Any, LayerAttempt, SpritePreparation | None]] = []
        sprites = self._sprites if self._l2_on(row) else None
        for plate in plates:
            current = await self._productions.get_row(row.production_id)
            if current.cancel_requested_at is not None:
                raise ComicServiceError(
                    "PRODUCTION_CANCELLED",
                    "production is cancelled",
                    retryable=False,
                )
            registration = await register_l0_panel(
                self._artifacts,
                tenant_id=row.tenant_id,
                project_id=row.project_id,
                production_id=row.production_id,
                record=describe_l0_panel(
                    shot_id=plate.shot.shot_id,
                    panel_url=str(plate.shot.panel_url),
                    source_width=plate.source_width,
                    source_height=plate.source_height,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                    full_page_fallback=plate.full_page_fallback,
                    warnings=tuple(plate.panel.diagnostics.warnings),
                ),
                source_checksum=plate.source_checksum,
            )
            try:
                attempt = await service.prepare_shot(
                    shot_id=plate.shot.shot_id,
                    source_url=str(plate.shot.panel_url),
                    source_checksum=plate.source_checksum,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
            except ComicServiceError as exc:
                if exc.code in {"JOB_LEASE_CONFLICT", "PRODUCTION_CANCELLED"}:
                    raise
                attempt = LayerAttempt(
                    shot_id=plate.shot.shot_id,
                    effective_level="L0",
                    downgrade_reason=exc.code,
                    package=None,
                    artifact_id=None,
                    input_hash="",
                )
            if attempt.pending:
                return None, False, False
            preparation = None
            if (
                sprites is not None
                and attempt.effective_level == "L1"
                and attempt.package is not None
                and not attempt.package.diagnostics.requires_fallback
            ):
                checksums: dict[str, str] = {}
                if attempt.artifact_id:
                    stored = await self._artifacts.get(attempt.artifact_id)
                    if stored is not None:
                        checksums = {
                            url: digest
                            for url, digest in zip(stored.urls, stored.checksums, strict=False)
                            if isinstance(url, str) and isinstance(digest, str)
                        }
                preparation = await sprites.prepare(
                    tenant_id=row.tenant_id,
                    production_id=row.production_id,
                    project_id=row.project_id,
                    package=attempt.package,
                    l1_input_hash=attempt.input_hash,
                    l1_checksums=checksums,
                    dialogues=tuple(
                        (dialogue.line_id, dialogue.from_frame, dialogue.duration_in_frames)
                        for dialogue in plate.shot.dialogues
                    ),
                )
                if preparation.pending:
                    return None, False, False
            prepared.append((plate, registration, attempt, preparation))

        # image/sequence must exist before layers/import. The payload matches the
        # COMPOSING command, so that later replay cannot unhide the L0 plate.
        # Capture panel-fit before layers/import hides the L0 plate tracks.
        shot_ids = [plate.shot.shot_id for plate, _registration, _attempt, _sprite in prepared]
        try:
            await self._apply(
                row.project_id,
                "image/sequence",
                l0_project_payload(
                    row.stage_facts,
                    [plate.shot for plate, _registration, _attempt, _sprite in prepared],
                    fallback_width=request.output.width,
                    fallback_height=request.output.height,
                ),
            )
        except ComicServiceError as exc:
            if exc.body.retryable:
                raise
            shots = [
                _shot_fact(plate, registration.artifact_id, attempt, command_id=None, revision=None)
                for plate, registration, attempt, _sprite in prepared
            ]
            for shot in shots:
                shot["effectiveAnimationLevel"] = "L0"
                shot["downgradeReason"] = shot["downgradeReason"] or "compose-failed"
            return (
                _stage_fact(
                    request,
                    shots,
                    self._thresholds.version,
                    self._model_version,
                    self._parameter_version,
                ),
                True,
                True,
            )

        fit_draft = await self._drafts.get(row.project_id)
        panel_fit_applied = committed_panel_fit_applied(fit_draft.project, shot_ids)

        shots: list[dict[str, Any]] = []
        for plate, registration, attempt, _sprite in prepared:
            command_id = None
            revision = None
            level = attempt.effective_level
            reason = attempt.downgrade_reason
            package = attempt.package
            if (
                level == "L1"
                and package is not None
                and not package.diagnostics.requires_fallback
            ):
                try:
                    applied = await self._apply(
                        row.project_id,
                        "layers/import",
                        layers_import_payload(package),
                    )
                except ComicServiceError as exc:
                    if exc.body.retryable:
                        raise
                    level = "L0"
                    reason = "compose-failed"
                else:
                    draft = await self._drafts.get(row.project_id)
                    if _l1_display_ok(draft.project, plate.shot.shot_id):
                        command_id = applied.command_id
                        revision = applied.resulting_revision
                    else:
                        level = "L0"
                        reason = "compose-failed"
                        if shot_needs_l0_restore(draft.project, plate.shot.shot_id):
                            await self._restore(row.project_id, plate.shot.shot_id)
            else:
                level = "L0"
                draft = await self._drafts.get(row.project_id)
                if shot_needs_l0_restore(draft.project, plate.shot.shot_id):
                    restored = await self._restore(row.project_id, plate.shot.shot_id)
                    revision = restored.resulting_revision
            fact = _shot_fact(
                plate,
                registration.artifact_id,
                attempt,
                command_id=command_id,
                revision=revision,
            )
            fact["effectiveAnimationLevel"] = level
            fact["downgradeReason"] = reason
            draft = await self._drafts.get(row.project_id)
            fact["l0AssetRetained"] = l0_asset_retained(draft.project, plate.shot.shot_id)
            shots.append(fact)
        if sprites is not None:
            unresolved = await sprites.commit(
                project_id=row.project_id,
                production_id=row.production_id,
                subtitle_mode=request.style.subtitle_mode,
                plates=[plate for plate, _registration, _attempt, _sprite in prepared],
                facts=shots,
                preparations=[sprite for _plate, _registration, _attempt, sprite in prepared],
                apply=lambda name, payload: self._apply_reported(row.project_id, name, payload),
            )
            if unresolved:
                return None, False, False
        degraded = any(shot["downgradeReason"] for shot in shots)
        extra: dict[str, Any] = {
            "panelFitApplied": panel_fit_applied,
        }
        if not panel_fit_applied:
            extra["panelFitReason"] = (
                "committed project is missing blurred-background layers"
            )
        if sprites is not None:
            extra["strategyVersion"] = sprites.strategy_version
            extra["spriteThresholdVersion"] = sprites.thresholds.version
        return (
            _stage_fact(
                request,
                shots,
                self._thresholds.version,
                self._model_version,
                self._parameter_version,
                extra=extra,
            ),
            degraded,
            True,
        )

    def _l2_on(self, row: ProductionRow) -> bool:
        if not self._l2_enabled or self._sprites is None:
            return False
        if self._l2_tenants is not None and row.tenant_id not in self._l2_tenants:
            return False
        return True

    async def _apply_reported(
        self,
        project_id: str,
        name: str,
        payload: dict[str, Any],
    ) -> MotionApplyResult:
        command = compose_command(project_id, name, payload)
        try:
            applied = await self._apply(project_id, name, payload)
        except ComicServiceError as exc:
            if exc.code == "DRAFT_REVISION_CONFLICT":
                return MotionApplyResult(command.command_id, None, True, False)
            if exc.body.retryable:
                raise
            return MotionApplyResult(command.command_id, None, False, True)
        return MotionApplyResult(applied.command_id, applied.resulting_revision, False, False)

    async def _restore(self, project_id: str, shot_id: str) -> AppliedComposeCommand:
        return await self._apply(project_id, "layers/restore-l0", {"shotId": shot_id})

    async def _apply(
        self,
        project_id: str,
        name: str,
        payload: dict[str, Any],
    ) -> AppliedComposeCommand:
        command = compose_command(project_id, name, payload)
        try:
            return await self._applier.apply(command)
        except ComicServiceError as exc:
            if exc.code != "DRAFT_REVISION_CONFLICT":
                raise
            return await self._applier.apply(command)


def _l1_display_ok(project: dict[str, Any], shot_id: str) -> bool:
    if not l0_asset_retained(project, shot_id):
        return False
    plate_ids = l0_plate_track_ids(shot_id)
    found = False
    for track in project.get("tracks") or []:
        if not isinstance(track, dict) or track.get("id") not in plate_ids:
            continue
        found = True
        if track.get("hidden") is not True:
            return False
    return found


def _shot_fact(
    plate: Any,
    l0_artifact_id: str,
    attempt: LayerAttempt,
    *,
    command_id: str | None,
    revision: int | None,
) -> dict[str, Any]:
    return {
        "shotId": plate.shot.shot_id,
        "effectiveAnimationLevel": attempt.effective_level,
        "downgradeReason": attempt.downgrade_reason,
        "l0ArtifactId": l0_artifact_id,
        "layerArtifactId": attempt.artifact_id,
        "commandId": command_id,
        "revision": revision,
        "l0AssetRetained": True,
        "warnings": list(attempt.warnings),
    }


def _stage_fact(
    request: Any,
    shots: list[dict[str, Any]],
    threshold_version: str,
    model_version: str,
    parameter_version: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    levels = {shot["effectiveAnimationLevel"] for shot in shots}
    if len(levels) == 1:
        level = next(iter(levels))
    elif not levels:
        level = "L0"
    else:
        level = "mixed"
    fact = {
        "level": level,
        "shotCount": len(shots),
        "shots": shots,
        "panelFitPolicy": request.output.panel_fit_policy,
        "panelFitApplied": False,
        "panelFitReason": "committed project is missing blurred-background layers",
        "thresholdVersion": threshold_version,
        "modelVersion": model_version,
        "parameterVersion": parameter_version,
    }
    if extra:
        fact.update(extra)
        if fact.get("panelFitApplied"):
            fact.pop("panelFitReason", None)
    return fact

