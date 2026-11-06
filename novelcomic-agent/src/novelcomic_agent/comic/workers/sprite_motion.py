"""Apply blink and mouth-flap after L1, one capability at a time."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ..assets.l2_sprite_service import L2SpriteService, SpriteAttempt, SpriteProvider, face_layer
from ..assets.sprite_quality_gate import (
    SpriteGateResult,
    SpriteGateThresholds,
    SpriteReference,
    evaluate_sprites,
)
from ..contracts.layer_package import LayerPackage, layers_import_payload
from ..contracts.sprite_state import SpriteStateAsset
from ..rendering.dialogue_payload import dialogue_and_voice_payloads
from ..rendering.motion_commands import (
    SPRITE_STRATEGY_VERSION,
    blink_motion_payload,
    mouth_motion_payload,
    sprite_import_package,
)
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..storage.object_store import ObjectStore


@dataclass(frozen=True, slots=True)
class MotionApplyResult:
    command_id: str | None
    revision: int | None
    conflict: bool
    failed: bool


@dataclass(frozen=True, slots=True)
class SpritePreparation:
    pending: bool
    attempt: SpriteAttempt
    gate: SpriteGateResult | None
    source_url: str | None


class SpriteCoordinator:
    """Stage D path. A shot stays on L1 until a motion command actually commits."""

    def __init__(
        self,
        *,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        drafts: LedgerDraftRepository,
        provider: SpriteProvider,
        provider_name: str,
        model_version: str,
        parameter_version: str,
        allowed_hosts: frozenset[str],
        worst_case_fen: int,
        thresholds: SpriteGateThresholds | None = None,
        strategy_version: str = SPRITE_STRATEGY_VERSION,
    ) -> None:
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._drafts = drafts
        self._provider = provider
        self._provider_name = provider_name
        self._model_version = model_version
        self._parameter_version = parameter_version
        self._allowed_hosts = allowed_hosts
        self._worst_case_fen = worst_case_fen
        self.thresholds = thresholds or SpriteGateThresholds()
        self.strategy_version = strategy_version

    async def prepare(
        self,
        *,
        tenant_id: str,
        production_id: str,
        project_id: str,
        package: LayerPackage,
        l1_input_hash: str,
        l1_checksums: dict[str, str],
        dialogues: tuple[tuple[str, int, int], ...],
    ) -> SpritePreparation:
        service = L2SpriteService(
            artifacts=self._artifacts,
            costs=self._costs,
            objects=self._objects,
            provider=self._provider,
            tenant_id=tenant_id,
            production_id=production_id,
            project_id=project_id,
            provider_name=self._provider_name,
            model_version=self._model_version,
            parameter_version=self._parameter_version,
            allowed_hosts=self._allowed_hosts,
            worst_case_fen=self._worst_case_fen,
            thresholds=self.thresholds,
        )
        attempt = await service.prepare_shot(
            package=package,
            l1_input_hash=l1_input_hash,
            l1_checksums=l1_checksums,
            dialogues=dialogues,
        )
        if attempt.pending:
            return SpritePreparation(True, attempt, None, None)
        face = face_layer(package)
        if attempt.asset_set is None or face is None:
            return SpritePreparation(False, attempt, None, None)
        gate = evaluate_sprites(
            attempt.asset_set,
            reference=SpriteReference(
                canvas_width=package.canvas.width,
                canvas_height=package.canvas.height,
                bounds=(face.bounds.x, face.bounds.y, face.bounds.width, face.bounds.height),
                anchor=(face.anchor.x, face.anchor.y),
            ),
            checksums={
                str(state.image_url): state.checksum for state in attempt.asset_set.states
            },
            thresholds=self.thresholds,
        )
        return SpritePreparation(False, attempt, gate, str(face.image_url))

    async def commit(
        self,
        *,
        project_id: str,
        production_id: str,
        subtitle_mode: str,
        plates: list[Any],
        facts: list[dict[str, Any]],
        preparations: list[SpritePreparation | None],
        apply: Callable[[str, dict[str, Any]], Awaitable[MotionApplyResult]],
    ) -> bool:
        """Return True when a CAS conflict is still unresolved."""

        unresolved = False
        dialogue_ready = True
        if _needs_mouth(plates, preparations):
            draft = await self._drafts.get(project_id)
            placed = {shot["id"]: shot for shot in draft.project.get("shots") or []}
            dialogue, _voice = dialogue_and_voice_payloads(
                [plate.shot for plate in plates],
                placed,
                subtitle_mode=subtitle_mode,
            )
            if dialogue is not None:
                result = await apply("dialogue/add", dialogue)
                if result.conflict:
                    unresolved = True
                    dialogue_ready = False
                elif result.failed:
                    dialogue_ready = False
        for fact, plate, preparation in zip(facts, plates, preparations, strict=True):
            if preparation is None:
                continue
            shot_unresolved = await self._commit_shot(
                fact,
                plate,
                preparation,
                production_id=production_id,
                dialogue_ready=dialogue_ready,
                apply=apply,
            )
            unresolved = unresolved or shot_unresolved
        return unresolved

    async def _commit_shot(
        self,
        fact: dict[str, Any],
        plate: Any,
        preparation: SpritePreparation,
        *,
        production_id: str,
        dialogue_ready: bool,
        apply: Callable[[str, dict[str, Any]], Awaitable[MotionApplyResult]],
    ) -> bool:
        attempt = preparation.attempt
        fact["spriteArtifactId"] = attempt.artifact_id
        fact["spriteInputHash"] = attempt.input_hash
        fact["warnings"] = list(dict.fromkeys([*fact.get("warnings", []), *attempt.warnings]))
        gate = preparation.gate
        if gate is None or attempt.asset_set is None:
            fact["capabilities"] = []
            fact["rejectedReasons"] = [attempt.downgrade_reason] if attempt.downgrade_reason else []
            if fact.get("effectiveAnimationLevel") == "L1" and attempt.downgrade_reason:
                fact["downgradeReason"] = attempt.downgrade_reason
            return False
        fact["rejectedReasons"] = list(gate.rejected_reasons)
        fact["spriteThresholdVersion"] = gate.threshold_version
        capabilities = [
            capability
            for capability in gate.capabilities
            if capability != "mouth-flap" or dialogue_ready
        ]
        if not capabilities or preparation.source_url is None:
            fact["capabilities"] = []
            fact["downgradeReason"] = (
                gate.rejected_reasons[0]
                if gate.rejected_reasons
                else "compose-failed"
                if not dialogue_ready
                else "missing-face"
            )
            return False
        states = _states_for(attempt.asset_set.states, gate, capabilities)
        imported = await apply(
            "layers/import",
            layers_import_payload(
                sprite_import_package(
                    attempt.asset_set,
                    states,
                    source_url=preparation.source_url,
                )
            ),
        )
        if imported.conflict:
            return True
        if imported.failed:
            fact["capabilities"] = []
            fact["downgradeReason"] = "compose-failed"
            return False
        dialogues = [
            (dialogue.line_id, dialogue.from_frame, dialogue.duration_in_frames)
            for dialogue in plate.shot.dialogues
        ]
        checksums = {state.asset_id: state.checksum for state in attempt.asset_set.states}
        succeeded: list[str] = []
        commands: list[dict[str, Any]] = []
        unresolved = False
        for capability in capabilities:
            if capability == "blink":
                payload = blink_motion_payload(
                    shot_id=plate.shot.shot_id,
                    production_id=production_id,
                    asset_checksums=checksums,
                    dialogues=dialogues,
                    shot_duration_in_frames=plate.shot.duration_in_frames,
                    strategy_version=self.strategy_version,
                )
            else:
                payload = mouth_motion_payload(
                    shot_id=plate.shot.shot_id,
                    line_ids=[dialogue.line_id for dialogue in plate.shot.dialogues],
                    include_half="half" in gate.mouth_semantics,
                    asset_checksums=checksums,
                    dialogues=dialogues,
                    shot_duration_in_frames=plate.shot.duration_in_frames,
                    strategy_version=self.strategy_version,
                )
            result = await apply("item/motion", payload)
            if result.conflict:
                unresolved = True
                continue
            if result.failed:
                continue
            succeeded.append(capability)
            commands.append(
                {
                    "capability": capability,
                    "commandId": result.command_id,
                    "revision": result.revision,
                }
            )
        fact["capabilities"] = succeeded
        fact["motionCommands"] = commands
        if succeeded:
            fact["effectiveAnimationLevel"] = "L2"
            dropped = [reason for reason in gate.rejected_reasons]
            if len(succeeded) != len(capabilities):
                dropped.append("compose-failed")
            fact["downgradeReason"] = dropped[0] if dropped else None
            fact["rejectedReasons"] = dropped
        else:
            fact["effectiveAnimationLevel"] = "L1"
            fact["downgradeReason"] = "compose-failed"
            fact["rejectedReasons"] = [*gate.rejected_reasons, "compose-failed"]
        return unresolved


def _needs_mouth(plates: list[Any], preparations: list[SpritePreparation | None]) -> bool:
    for plate, preparation in zip(plates, preparations, strict=True):
        if (
            preparation is not None
            and preparation.gate is not None
            and preparation.gate.mouth_flap
            and plate.shot.dialogues
        ):
            return True
    return False


def _states_for(
    states: list[SpriteStateAsset],
    gate: SpriteGateResult,
    capabilities: list[str],
) -> list[SpriteStateAsset]:
    wanted: set[tuple[str, str]] = set()
    if "blink" in capabilities:
        wanted.update({("eye", "open"), ("eye", "closed")})
    if "mouth-flap" in capabilities:
        wanted.update({("mouth", semantic) for semantic in gate.mouth_semantics})
    return [state for state in states if (state.part, state.semantic) in wanted]
