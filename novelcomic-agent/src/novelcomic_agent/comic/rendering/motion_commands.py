"""Controlled item/motion payloads. Callers cannot submit an arbitrary patch."""

from __future__ import annotations

import hashlib
from typing import Any

from ..canonical import hash_content
from ..contracts.errors import ComicServiceError
from ..contracts.layer_package import (
    Layer,
    LayerCanvas,
    LayerDiagnostics,
    LayerPackage,
)
from ..contracts.sprite_state import (
    SpriteAssetSet,
    SpriteStateAsset,
    dialogue_item_id,
    eye_item_id,
    mouth_item_id,
    remotion_layer_semantic,
    sprite_asset_id,
)

SPRITE_STRATEGY_VERSION = "sprite-motion-v1"
ITEM_PRESETS = frozenset({"breathing", "float", "hair-sway"})
CAMERA_PRESETS = frozenset({"camera-push", "camera-pull", "pan-left", "pan-right"})
COMPOSABLE_PRESETS = ITEM_PRESETS
_LAYER_Z = {
    "mouth-closed": 21,
    "mouth-half": 22,
    "mouth-open": 23,
    "eye-open": 30,
    "eye-closed": 31,
}


def blink_seed(
    production_id: str,
    shot_id: str,
    strategy_version: str = SPRITE_STRATEGY_VERSION,
) -> int:
    """Derive the blink seed. Clock time and process randomness are not inputs."""

    digest = hashlib.sha256(f"{production_id}\n{shot_id}\n{strategy_version}".encode()).digest()
    value = int.from_bytes(digest[:4], "big") & 0x7FFFFFFF
    return value or 1


def motion_input_hash(
    *,
    shot_id: str,
    capability: str,
    strategy_version: str,
    seed: int | None,
    asset_checksums: dict[str, str],
    dialogues: list[dict[str, int | str]],
    shot_duration_in_frames: int,
    mode: str,
) -> str:
    """Identity of one motion command.

    The live draft content hash changes once this command commits, so it is not
    part of the identity. The dialogue timeline, assets, seed, and strategy are.
    A later timeline produces a different command instead of replaying the old one.
    """

    return hash_content(
        {
            "assetChecksums": asset_checksums,
            "capability": capability,
            "dialogues": dialogues,
            "mode": mode,
            "seed": seed,
            "shotDurationInFrames": shot_duration_in_frames,
            "shotId": shot_id,
            "strategyVersion": strategy_version,
        }
    )


def dialogue_timeline(dialogues: list[tuple[str, int, int]]) -> list[dict[str, int | str]]:
    return [
        {"durationInFrames": duration, "fromFrame": start, "lineId": line_id}
        for line_id, start, duration in dialogues
    ]


def blink_motion_payload(
    *,
    shot_id: str,
    production_id: str,
    asset_checksums: dict[str, str],
    dialogues: list[tuple[str, int, int]],
    shot_duration_in_frames: int,
    strategy_version: str = SPRITE_STRATEGY_VERSION,
) -> dict[str, Any]:
    seed = blink_seed(production_id, shot_id, strategy_version)
    timeline = dialogue_timeline(dialogues)
    return {
        "mode": "replace",
        "target": {"type": "item", "itemId": eye_item_id(shot_id)},
        "sprite": {
            "kind": "blink",
            "openAssetId": sprite_asset_id(shot_id, "eye", "open"),
            "closedAssetId": sprite_asset_id(shot_id, "eye", "closed"),
            "seed": seed,
        },
        "motionInputHash": motion_input_hash(
            shot_id=shot_id,
            capability="blink",
            strategy_version=strategy_version,
            seed=seed,
            asset_checksums=asset_checksums,
            dialogues=timeline,
            shot_duration_in_frames=shot_duration_in_frames,
            mode="replace",
        ),
    }


def mouth_motion_payload(
    *,
    shot_id: str,
    line_ids: list[str],
    include_half: bool,
    asset_checksums: dict[str, str],
    dialogues: list[tuple[str, int, int]],
    shot_duration_in_frames: int,
    strategy_version: str = SPRITE_STRATEGY_VERSION,
) -> dict[str, Any]:
    if not line_ids:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "mouth-flap requires committed dialogue items",
            retryable=False,
            details={"shotId": shot_id},
        )
    sprite: dict[str, Any] = {
        "kind": "mouth-flap",
        "closedAssetId": sprite_asset_id(shot_id, "mouth", "closed"),
        "openAssetId": sprite_asset_id(shot_id, "mouth", "open"),
        "dialogueItemIds": [dialogue_item_id(shot_id, line_id) for line_id in line_ids],
    }
    if include_half:
        sprite["halfAssetId"] = sprite_asset_id(shot_id, "mouth", "half")
    return {
        "mode": "replace",
        "target": {"type": "item", "itemId": mouth_item_id(shot_id)},
        "sprite": sprite,
        "motionInputHash": motion_input_hash(
            shot_id=shot_id,
            capability="mouth-flap",
            strategy_version=strategy_version,
            seed=None,
            asset_checksums=asset_checksums,
            dialogues=dialogue_timeline(dialogues),
            shot_duration_in_frames=shot_duration_in_frames,
            mode="replace",
        ),
    }


def preset_motion_payload(
    *,
    shot_id: str,
    preset_id: str,
    mode: str,
    seed: int,
    item_id: str | None,
    parameters: dict[str, str | int | float | bool] | None,
    asset_checksums: dict[str, str],
    dialogues: list[tuple[str, int, int]],
    shot_duration_in_frames: int,
    strategy_version: str = SPRITE_STRATEGY_VERSION,
) -> dict[str, Any]:
    if preset_id in CAMERA_PRESETS:
        target: dict[str, Any] = {"type": "shot", "shotId": shot_id, "presetId": preset_id}
    elif preset_id in ITEM_PRESETS:
        if not item_id:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "item preset requires an item on this shot",
                retryable=False,
                details={"shotId": shot_id, "presetId": preset_id},
            )
        target = {"type": "item", "itemId": item_id, "presetId": preset_id}
    else:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "motion preset is not registered",
            retryable=False,
            details={"presetId": preset_id},
        )
    payload: dict[str, Any] = {
        "mode": mode,
        "target": target,
        "seed": seed,
        "motionInputHash": motion_input_hash(
            shot_id=shot_id,
            capability=preset_id,
            strategy_version=strategy_version,
            seed=seed,
            asset_checksums=asset_checksums,
            dialogues=dialogue_timeline(dialogues),
            shot_duration_in_frames=shot_duration_in_frames,
            mode=mode,
        ),
    }
    if parameters:
        payload["parameters"] = parameters
    return payload


def ensure_motion_mode(mode: str, *, sprite: str | None, preset_id: str | None) -> None:
    if mode not in {"replace", "append"}:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "motion mode must be replace or append",
            retryable=False,
        )
    if mode == "append" and (sprite is not None or preset_id not in COMPOSABLE_PRESETS):
        raise ComicServiceError(
            "INVALID_REQUEST",
            "append is only allowed for composable item presets",
            retryable=False,
            details={"presetId": preset_id, "sprite": sprite},
        )


def sprite_import_package(
    asset_set: SpriteAssetSet,
    states: list[SpriteStateAsset],
    *,
    source_url: str,
) -> LayerPackage:
    """Register state images through layers/import. spriteStates stay unset."""

    layers = [_layer(state) for state in states]
    layers.sort(key=lambda layer: (layer.semantic.startswith("mouth"), layer.semantic))
    return LayerPackage(
        project_id=asset_set.project_id,
        shot_id=asset_set.shot_id,
        source_url=source_url,  # type: ignore[arg-type]
        canvas=LayerCanvas(width=asset_set.canvas.width, height=asset_set.canvas.height),
        layers=layers,
        diagnostics=LayerDiagnostics(
            recomposition_score=0,
            alpha_hole_ratio=0,
            edge_artifact_score=0,
            requires_fallback=False,
            warnings=list(asset_set.warnings),
        ),
    )


def _layer(state: SpriteStateAsset) -> Layer:
    semantic = remotion_layer_semantic(state.part, state.semantic)
    return Layer(
        layer_id=semantic,
        name=semantic,
        semantic=semantic,  # type: ignore[arg-type]
        image_url=state.image_url,
        z_index=_LAYER_Z[semantic],
        visible=True,
        bounds=state.bounds,
        anchor=state.anchor,
        confidence=1,
        motion_policy="subtle",
    )
