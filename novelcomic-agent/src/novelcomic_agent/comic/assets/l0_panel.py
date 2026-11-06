"""L0 plate registration. Fit is described here and rendered by Remotion."""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any

from ..canonical import hash_content
from ..contracts.panel_spec import PanelSpec
from ..contracts.timed_shot_spec import TimedShotSpec
from ..repositories.artifact_repository import ArtifactRepository

FIT_POLICY = "blurred-background-contain"
FIT_ALGORITHM_VERSION = "contain-blur-v1"
BLUR_RADIUS_PX = 28
DIM_OPACITY = 0.45
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True, slots=True)
class L0Placement:
    x: int
    y: int
    width: int
    height: int
    fit: str

    def as_dict(self) -> dict[str, int | str]:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "fit": self.fit,
        }


@dataclass(frozen=True, slots=True)
class L0FitDescription:
    policy: str
    algorithm_version: str
    blur_radius_px: int
    dim_opacity: float
    foreground: L0Placement
    background: L0Placement

    def as_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy,
            "algorithmVersion": self.algorithm_version,
            "blurRadiusPx": self.blur_radius_px,
            "dimOpacity": self.dim_opacity,
            "foreground": self.foreground.as_dict(),
            "background": {
                **self.background.as_dict(),
                "blur": True,
                "dimOpacity": self.dim_opacity,
            },
        }


@dataclass(frozen=True, slots=True)
class L0PanelRecord:
    shot_id: str
    panel_url: str
    source_width: int
    source_height: int
    canvas_width: int
    canvas_height: int
    visible: bool
    full_page_fallback: bool
    fit: L0FitDescription
    warnings: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "shotId": self.shot_id,
            "panelUrl": self.panel_url,
            "sourceWidth": self.source_width,
            "sourceHeight": self.source_height,
            "canvas": {"width": self.canvas_width, "height": self.canvas_height},
            "visible": self.visible,
            "fullPageFallback": self.full_page_fallback,
            "fit": self.fit.as_dict(),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True, slots=True)
class ShotPlate:
    shot: TimedShotSpec
    panel: PanelSpec
    source_width: int
    source_height: int
    source_checksum: str
    full_page_fallback: bool


@dataclass(frozen=True, slots=True)
class L0Registration:
    artifact_id: str
    record: L0PanelRecord
    reused: bool


def l0_sequence_image(
    shot: TimedShotSpec,
    *,
    width: int,
    height: int,
) -> dict[str, Any]:
    """Use the panel crop or full-page fallback already frozen on the shot."""

    return {
        "shotId": shot.shot_id,
        "url": str(shot.panel_url),
        "width": width,
        "height": height,
        "durationInFrames": shot.duration_in_frames,
        "cameraPresetId": shot.camera_preset_id,
        "seed": shot.seed,
    }


def l0_sequence_payload(
    shots: list[TimedShotSpec],
    *,
    width: int,
    height: int,
    composition_width: int | None = None,
    composition_height: int | None = None,
    frame_sizes: dict[str, tuple[int, int]] | None = None,
) -> dict[str, Any]:
    """Shared image/sequence body so PREPARING and COMPOSING replay one command."""

    images = []
    for shot in shots:
        frame = (frame_sizes or {}).get(shot.shot_id)
        frame_width, frame_height = frame if frame is not None else (width, height)
        images.append(l0_sequence_image(shot, width=frame_width, height=frame_height))
    payload: dict[str, Any] = {
        "images": images,
        "panelFitPolicy": FIT_POLICY,
        "fitAlgorithmVersion": FIT_ALGORITHM_VERSION,
        "blurRadiusPx": BLUR_RADIUS_PX,
        "dimOpacity": DIM_OPACITY,
    }
    if composition_width is not None and composition_height is not None:
        payload["compositionWidth"] = composition_width
        payload["compositionHeight"] = composition_height
    return payload


def composition_size(
    stage_facts: dict[str, Any],
    fallback_width: int,
    fallback_height: int,
) -> tuple[int, int]:
    """Use the analyzer canvas so later Compose replays the same image/sequence."""

    fact = stage_facts.get("ANALYZING") or {}
    width = fact.get("canvasWidth")
    height = fact.get("canvasHeight")
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        return width, height
    return fallback_width, fallback_height


def frame_sizes_for_shots(
    stage_facts: dict[str, Any],
    shots: list[TimedShotSpec],
) -> dict[str, tuple[int, int]]:
    panels = panels_by_identity(stage_facts)
    sizes: dict[str, tuple[int, int]] = {}
    for shot in shots:
        panel = panels.get((shot.page_id, shot.panel_index))
        if panel is None:
            continue
        sizes[shot.shot_id] = (
            max(1, _round(panel.bounds.width)),
            max(1, _round(panel.bounds.height)),
        )
    return sizes


def l0_project_payload(
    stage_facts: dict[str, Any],
    shots: list[TimedShotSpec],
    *,
    fallback_width: int,
    fallback_height: int,
) -> dict[str, Any]:
    width, height = composition_size(stage_facts, fallback_width, fallback_height)
    return l0_sequence_payload(
        shots,
        width=width,
        height=height,
        composition_width=width,
        composition_height=height,
        frame_sizes=frame_sizes_for_shots(stage_facts, shots),
    )


def l0_track_id(shot_id: str) -> str:
    return f"track:{shot_id}:panel"


def l0_asset_id(shot_id: str) -> str:
    return f"asset:{shot_id}:panel"


def l0_item_id(shot_id: str) -> str:
    return f"item:{shot_id}:panel"


def l0_foreground_item_id(shot_id: str) -> str:
    return f"item:{shot_id}:panel-foreground"


def l0_background_item_id(shot_id: str) -> str:
    return f"item:{shot_id}:panel-background"


def l0_foreground_track_id(shot_id: str) -> str:
    return f"track:{shot_id}:panel-foreground"


def l0_background_track_id(shot_id: str) -> str:
    return f"track:{shot_id}:panel-background"


def l0_plate_track_ids(shot_id: str) -> set[str]:
    return {
        l0_track_id(shot_id),
        l0_foreground_track_id(shot_id),
        l0_background_track_id(shot_id),
    }


def describe_l0_panel(
    *,
    shot_id: str,
    panel_url: str,
    source_width: int,
    source_height: int,
    canvas_width: int,
    canvas_height: int,
    full_page_fallback: bool,
    visible: bool = True,
    warnings: tuple[str, ...] = (),
) -> L0PanelRecord:
    """Describe blurred-background contain. This function does not render pixels."""

    if min(source_width, source_height, canvas_width, canvas_height) < 1:
        raise ValueError("panel and canvas dimensions must be positive")
    contain = min(canvas_width / source_width, canvas_height / source_height)
    cover = max(canvas_width / source_width, canvas_height / source_height)
    return L0PanelRecord(
        shot_id=shot_id,
        panel_url=panel_url,
        source_width=source_width,
        source_height=source_height,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        visible=visible,
        full_page_fallback=full_page_fallback,
        warnings=warnings,
        fit=L0FitDescription(
            policy=FIT_POLICY,
            algorithm_version=FIT_ALGORITHM_VERSION,
            blur_radius_px=BLUR_RADIUS_PX,
            dim_opacity=DIM_OPACITY,
            foreground=_placement(
                contain, source_width, source_height, canvas_width, canvas_height, "contain"
            ),
            background=_placement(
                cover, source_width, source_height, canvas_width, canvas_height, "cover"
            ),
        ),
    )


def l0_input_hash(record: L0PanelRecord, source_checksum: str) -> str:
    return hash_content(
        {
            "algorithmVersion": record.fit.algorithm_version,
            "canvas": {"height": record.canvas_height, "width": record.canvas_width},
            "fullPageFallback": record.full_page_fallback,
            "panelUrl": record.panel_url,
            "policy": record.fit.policy,
            "shotId": record.shot_id,
            "sourceChecksum": source_checksum,
            "sourceHeight": record.source_height,
            "sourceWidth": record.source_width,
        }
    )


def shot_needs_l0_restore(project: dict[str, Any], shot_id: str) -> bool:
    """True when the display plate is hidden or an enhancement track is showing."""

    plate_ids = l0_plate_track_ids(shot_id)
    prefix = f"track:{shot_id}:"
    for track in project.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        track_id = str(track.get("id") or "")
        if track_id in plate_ids and track.get("hidden") is True:
            return True
        if (
            track_id.startswith(prefix)
            and track_id not in plate_ids
            and ":voice:" not in track_id
            and track.get("semantic") != "dialogue"
            and track.get("hidden") is not True
        ):
            return True
    return False


def l0_asset_retained(project: dict[str, Any], shot_id: str) -> bool:
    assets = project.get("assets") or {}
    items = project.get("items") or {}
    return l0_asset_id(shot_id) in assets and (
        l0_item_id(shot_id) in items or l0_foreground_item_id(shot_id) in items
    )


def committed_panel_fit_applied(project: dict[str, Any], shot_ids: list[str]) -> bool:
    """True only when every shot has both blurred-background layers in the project."""

    if not shot_ids:
        return False
    items = project.get("items") or {}
    assets = project.get("assets") or {}
    tracks = {
        str(track.get("id")): track
        for track in project.get("tracks") or []
        if isinstance(track, dict)
    }
    order = [
        str(track.get("id"))
        for track in project.get("tracks") or []
        if isinstance(track, dict)
    ]
    for shot_id in shot_ids:
        asset_id = l0_asset_id(shot_id)
        foreground_id = l0_foreground_item_id(shot_id)
        background_id = l0_background_item_id(shot_id)
        foreground_track_id = l0_foreground_track_id(shot_id)
        background_track_id = l0_background_track_id(shot_id)
        foreground = items.get(foreground_id)
        background = items.get(background_id)
        foreground_track = tracks.get(foreground_track_id)
        background_track = tracks.get(background_track_id)
        if (
            asset_id not in assets
            or not isinstance(foreground, dict)
            or not isinstance(background, dict)
        ):
            return False
        if not isinstance(foreground_track, dict) or not isinstance(background_track, dict):
            return False
        if foreground.get("assetId") != asset_id or background.get("assetId") != asset_id:
            return False
        if foreground.get("fit") != "contain" or foreground.get("role") != "panel-foreground":
            return False
        if background.get("fit") != "cover" or background.get("role") != "panel-background":
            return False
        if foreground.get("blurRadiusPx") not in (None, 0):
            return False
        if background.get("blurRadiusPx") != BLUR_RADIUS_PX or not _same_dim(
            background.get("dimOpacity")
        ):
            return False
        if foreground_track.get("hidden") is True or background_track.get("hidden") is True:
            return False
        if foreground_id not in (foreground_track.get("items") or []):
            return False
        if background_id not in (background_track.get("items") or []):
            return False
        try:
            if order.index(foreground_track_id) > order.index(background_track_id):
                return False
        except ValueError:
            return False
    return True


def _same_dim(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isclose(float(value), DIM_OPACITY, rel_tol=0, abs_tol=1e-9)


def panels_by_identity(stage_facts: dict[str, Any]) -> dict[tuple[str, int], PanelSpec]:
    panels = stage_facts["ANALYZING"]["panels"]
    indexed: dict[tuple[str, int], PanelSpec] = {}
    for item in panels:
        panel = PanelSpec.model_validate(item)
        indexed[(panel.page_id, panel.panel_index)] = panel
    return indexed


def shot_plates(stage_facts: dict[str, Any]) -> list[ShotPlate]:
    """Join frozen shots to the analyzer plate. Dimensions come from the panel bounds."""

    panels = panels_by_identity(stage_facts)
    plates: list[ShotPlate] = []
    for item in stage_facts["SYNTHESIZING_VOICE"]["shots"]:
        shot = TimedShotSpec.model_validate(item)
        panel = panels.get((shot.page_id, shot.panel_index))
        if panel is None:
            raise KeyError(shot.shot_id)
        plates.append(
            ShotPlate(
                shot=shot,
                panel=panel,
                source_width=_pixel(panel.bounds.width),
                source_height=_pixel(panel.bounds.height),
                source_checksum=source_checksum(str(panel.panel_url), str(panel.source_url)),
                full_page_fallback=str(panel.panel_url) == str(panel.source_url),
            )
        )
    return plates


def source_checksum(panel_url: str, source_url: str) -> str:
    suffix = panel_url.rsplit("-", 1)[-1].split("?", 1)[0]
    if _SHA256.fullmatch(suffix):
        return suffix
    return hashlib.sha256(f"{panel_url}|{source_url}".encode()).hexdigest()


async def register_l0_panel(
    artifacts: ArtifactRepository,
    *,
    tenant_id: str,
    project_id: str,
    production_id: str,
    record: L0PanelRecord,
    source_checksum: str,
) -> L0Registration:
    """Index the plate. A repeated registration does not create another row."""

    input_hash = l0_input_hash(record, source_checksum)
    artifact_id = f"l0:{production_id}:{input_hash[:32]}"
    claim = await artifacts.claim(
        tenant_id=tenant_id,
        project_id=project_id,
        stage="l0-panel",
        input_hash=input_hash,
        artifact_id=artifact_id,
        provider="l0",
        shot_id=record.shot_id,
    )
    if claim.artifact.status == "completed":
        return L0Registration(claim.artifact.artifact_id, record, reused=True)
    if not claim.start_work:
        return L0Registration(claim.artifact.artifact_id, record, reused=True)
    await artifacts.complete(
        claim.artifact.artifact_id,
        urls=[record.panel_url],
        checksums=[source_checksum],
        diagnostics=record.as_dict(),
        cost_fen=0,
    )
    return L0Registration(claim.artifact.artifact_id, record, reused=False)


def _placement(
    scale: float,
    source_width: int,
    source_height: int,
    canvas_width: int,
    canvas_height: int,
    fit: str,
) -> L0Placement:
    width = max(1, _round(source_width * scale))
    height = max(1, _round(source_height * scale))
    return L0Placement(
        x=_round((canvas_width - width) / 2),
        y=_round((canvas_height - height) / 2),
        width=width,
        height=height,
        fit=fit,
    )


def _round(value: float) -> int:
    return int(math.floor(value + 0.5))


def _pixel(value: float) -> int:
    size = _round(value)
    if size < 1:
        raise ValueError("panel dimension must be positive")
    return size
