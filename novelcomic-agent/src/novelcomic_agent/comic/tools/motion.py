"""Controlled item/motion tool. The command goes through Compose CAS."""

from __future__ import annotations

import math
from typing import Any

from ..contracts.errors import ComicServiceError
from ..contracts.sprite_state import (
    dialogue_item_id,
    eye_item_id,
    mouth_item_id,
    sprite_asset_id,
)
from ..contracts.timed_shot_spec import TimedShotSpec
from ..drafts.apply_compose_command import ComposeCommandApplier
from ..rendering.commands import compose_command
from ..rendering.motion_commands import (
    CAMERA_PRESETS,
    ITEM_PRESETS,
    blink_motion_payload,
    blink_seed,
    ensure_motion_mode,
    mouth_motion_payload,
    preset_motion_payload,
)
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionNotFoundError, ProductionRepository


class MotionTools:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        applier: ComposeCommandApplier,
        artifacts: ArtifactRepository | None = None,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._applier = applier
        self._artifacts = artifacts

    async def apply(
        self,
        tenant_id: str,
        production_id: str,
        *,
        shot_id: str,
        expected_revision: int,
        mode: str = "replace",
        sprite: str | None = None,
        preset_id: str | None = None,
        item_id: str | None = None,
        parameters: dict[str, Any] | None = None,
        seed: int | None = None,
    ) -> dict[str, Any]:
        if (sprite is None) == (preset_id is None):
            raise ComicServiceError(
                "INVALID_REQUEST",
                "motion needs one sprite capability or one preset",
                retryable=False,
            )
        if sprite not in {None, "blink", "mouth-flap"}:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "sprite capability is not registered",
                retryable=False,
                details={"sprite": sprite},
            )
        ensure_motion_mode(mode, sprite=sprite, preset_id=preset_id)
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        if row.cancel_requested_at is not None:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "production is cancelled",
                retryable=False,
            )
        shot = _shot(row.stage_facts, shot_id)
        draft = await self._drafts.get(row.project_id)
        if draft.revision != expected_revision:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "motion is not bound to the committed revision",
                retryable=True,
                details={"revision": draft.revision},
            )
        dialogues = [
            (dialogue.line_id, dialogue.from_frame, dialogue.duration_in_frames)
            for dialogue in shot.dialogues
        ]
        if sprite is None:
            checksums = _asset_checksums(draft.project)
        else:
            checksums = await _sprite_checksums(self._artifacts, row.stage_facts, shot_id)
        if sprite == "blink":
            _require_image_asset(draft.project, sprite_asset_id(shot_id, "eye", "open"), shot_id)
            _require_image_asset(draft.project, sprite_asset_id(shot_id, "eye", "closed"), shot_id)
            _require_shot_item(draft.project, eye_item_id(shot_id), shot_id)
            payload = blink_motion_payload(
                shot_id=shot_id,
                production_id=production_id,
                asset_checksums=checksums,
                dialogues=dialogues,
                shot_duration_in_frames=shot.duration_in_frames,
            )
            capabilities = ["blink"]
        elif sprite == "mouth-flap":
            if not shot.dialogues:
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "mouth-flap requires dialogue on this shot",
                    retryable=False,
                    details={"shotId": shot_id},
                )
            _require_image_asset(
                draft.project,
                sprite_asset_id(shot_id, "mouth", "closed"),
                shot_id,
            )
            _require_image_asset(draft.project, sprite_asset_id(shot_id, "mouth", "open"), shot_id)
            half = sprite_asset_id(shot_id, "mouth", "half")
            include_half = _image_asset(draft.project, half) is not None
            _require_shot_item(draft.project, mouth_item_id(shot_id), shot_id)
            for dialogue in shot.dialogues:
                _require_dialogue_item(
                    draft.project,
                    dialogue_item_id(shot_id, dialogue.line_id),
                    shot_id,
                )
            payload = mouth_motion_payload(
                shot_id=shot_id,
                line_ids=[dialogue.line_id for dialogue in shot.dialogues],
                include_half=include_half,
                asset_checksums=checksums,
                dialogues=dialogues,
                shot_duration_in_frames=shot.duration_in_frames,
            )
            capabilities = ["mouth-flap"]
        else:
            assert preset_id is not None
            target_item = item_id
            if preset_id in ITEM_PRESETS:
                if target_item is None:
                    raise ComicServiceError(
                        "INVALID_REQUEST",
                        "item preset requires an item on this shot",
                        retryable=False,
                        details={"shotId": shot_id},
                    )
                _require_shot_item(draft.project, target_item, shot_id)
            elif preset_id in CAMERA_PRESETS:
                _require_shot(draft.project, shot_id)
                target_item = None
            else:
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "motion preset is not registered",
                    retryable=False,
                    details={"presetId": preset_id},
                )
            payload = preset_motion_payload(
                shot_id=shot_id,
                preset_id=preset_id,
                mode=mode,
                seed=seed if seed is not None else blink_seed(production_id, shot_id),
                item_id=target_item,
                parameters=_clean_parameters(parameters),
                asset_checksums=checksums,
                dialogues=dialogues,
                shot_duration_in_frames=shot.duration_in_frames,
            )
            capabilities = [preset_id]
        command = compose_command(row.project_id, "item/motion", payload)
        try:
            applied = await self._applier.apply(command)
        except ComicServiceError as exc:
            if exc.code == "DRAFT_REVISION_CONFLICT":
                applied = await self._applier.apply(command)
            elif exc.body.retryable:
                raise
            else:
                return {
                    "commandId": command.command_id,
                    "revision": draft.revision,
                    "capabilities": [],
                    "effectiveLevel": _stored_level(row.stage_facts, shot_id),
                }
        return {
            "commandId": applied.command_id,
            "revision": applied.resulting_revision,
            "capabilities": capabilities,
            "effectiveLevel": (
                "L2" if sprite is not None else _stored_level(row.stage_facts, shot_id)
            ),
        }


def _shot(stage_facts: dict[str, Any], shot_id: str) -> TimedShotSpec:
    payload = (stage_facts.get("SYNTHESIZING_VOICE") or {}).get("shots")
    if not isinstance(payload, list):
        raise ComicServiceError(
            "INVALID_REQUEST",
            "shot timeline is not committed",
            retryable=False,
            details={"shotId": shot_id},
        )
    for item in payload:
        shot = TimedShotSpec.model_validate(item)
        if shot.shot_id == shot_id:
            return shot
    raise ComicServiceError(
        "INVALID_REQUEST",
        "shot was not found on the production",
        retryable=False,
        details={"shotId": shot_id},
    )


def _stored_level(stage_facts: dict[str, Any], shot_id: str) -> str:
    shots = (stage_facts.get("PREPARING_ASSETS") or {}).get("shots") or []
    for shot in shots:
        if isinstance(shot, dict) and shot.get("shotId") == shot_id:
            return str(shot.get("effectiveAnimationLevel") or "L1")
    return "L1"


async def _sprite_checksums(
    artifacts: ArtifactRepository | None,
    stage_facts: dict[str, Any],
    shot_id: str,
) -> dict[str, str]:
    """Use the committed L2 bytes. The draft does not store those checksums."""

    if artifacts is None:
        return {}
    artifact_id = None
    for shot in (stage_facts.get("PREPARING_ASSETS") or {}).get("shots") or []:
        if isinstance(shot, dict) and shot.get("shotId") == shot_id:
            artifact_id = shot.get("spriteArtifactId")
    if not isinstance(artifact_id, str):
        return {}
    stored = await artifacts.get(artifact_id)
    payload = stored.diagnostics.get("assetSet") if stored is not None else None
    if not isinstance(payload, dict):
        return {}
    checksums: dict[str, str] = {}
    for state in payload.get("states") or []:
        if (
            isinstance(state, dict)
            and isinstance(state.get("assetId"), str)
            and isinstance(state.get("checksum"), str)
        ):
            checksums[state["assetId"]] = state["checksum"]
    return checksums


def _asset_checksums(project: dict[str, Any]) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for asset_id, asset in (project.get("assets") or {}).items():
        if isinstance(asset, dict) and isinstance(asset.get("checksum"), str):
            checksums[str(asset_id)] = asset["checksum"]
    return checksums


def _image_asset(project: dict[str, Any], asset_id: str) -> dict[str, Any] | None:
    asset = (project.get("assets") or {}).get(asset_id)
    if isinstance(asset, dict) and asset.get("type", "image") == "image":
        return asset
    return None


def _require_image_asset(project: dict[str, Any], asset_id: str, shot_id: str) -> None:
    if _image_asset(project, asset_id) is None or not asset_id.startswith(f"asset:{shot_id}:"):
        raise ComicServiceError(
            "INVALID_REQUEST",
            "sprite asset is not on this shot",
            retryable=False,
            details={"shotId": shot_id, "assetId": asset_id},
        )


def _require_shot_item(project: dict[str, Any], item_id: str, shot_id: str) -> None:
    item = (project.get("items") or {}).get(item_id)
    if not isinstance(item, dict) or item.get("shotId") != shot_id:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "motion item is not on this shot",
            retryable=False,
            details={"shotId": shot_id, "itemId": item_id},
        )


def _require_dialogue_item(project: dict[str, Any], item_id: str, shot_id: str) -> None:
    item = (project.get("items") or {}).get(item_id)
    if not isinstance(item, dict) or item.get("shotId") != shot_id:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "dialogue item is not on this shot",
            retryable=False,
            details={"shotId": shot_id, "itemId": item_id},
        )
    if not item_id.startswith(f"dialogue:{shot_id}:"):
        raise ComicServiceError(
            "INVALID_REQUEST",
            "dialogue item is not on this shot",
            retryable=False,
            details={"shotId": shot_id, "itemId": item_id},
        )


def _require_shot(project: dict[str, Any], shot_id: str) -> None:
    shots = project.get("shots") or []
    if not any(isinstance(shot, dict) and shot.get("id") == shot_id for shot in shots):
        raise ComicServiceError(
            "INVALID_REQUEST",
            "shot is not on the committed draft",
            retryable=False,
            details={"shotId": shot_id},
        )


def _clean_parameters(
    parameters: dict[str, Any] | None,
) -> dict[str, str | int | float | bool] | None:
    if not parameters:
        return None
    cleaned: dict[str, str | int | float | bool] = {}
    for key, value in parameters.items():
        if isinstance(value, bool) or isinstance(value, (int, float, str)):
            if isinstance(value, float) and not math.isfinite(value):
                raise ComicServiceError(
                    "INVALID_REQUEST",
                    "motion parameter must be finite",
                    retryable=False,
                    details={"parameter": str(key)},
                )
            cleaned[str(key)] = value
            continue
        raise ComicServiceError(
            "INVALID_REQUEST",
            "motion parameter is not a scalar",
            retryable=False,
            details={"parameter": str(key)},
        )
    return cleaned
