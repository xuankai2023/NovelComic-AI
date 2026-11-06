"""Shared fakes for the stage B control-plane tests."""

from __future__ import annotations

import copy
from decimal import Decimal
from io import BytesIO
from typing import Any

from fastapi import Request
from PIL import Image

from novelcomic_agent.comic.analyzer.panel_analyzer import (
    DetectedBubble,
    DetectedPanel,
    PageDetection,
)
from novelcomic_agent.comic.audio.voice_synthesizer import ProviderTimeout, SpeechSynthesis
from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.contracts.production_request import (
    BudgetSpec,
    OutputSpec,
    ProductionRequest,
    SourcePage,
    StyleSpec,
)
from novelcomic_agent.comic.drafts.apply_compose_command import ComposeResult
from novelcomic_agent.comic.rendering.remotion_client import RenderProgress, ValidationReport
from novelcomic_agent.comic.rendering.sprite_states import (
    build_blink_sprite_states,
    build_mouth_flap_sprite_states,
)

FAIL_LINE = "fail this line"


def page_png(label: str = "page") -> bytes:
    """Portrait PNG so analyzer measurement matches ScriptedDetector and stays 9:16."""

    image = Image.new("RGB", (1000, 1600), (32, 64, 180))
    seed = sum(label.encode()) % 256
    image.putpixel((1, 1), (seed, 255 - seed, 40))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


async def tenant_from_header(request: Request) -> str:
    tenant = request.headers.get("x-test-tenant")
    if not tenant:
        raise ComicServiceError("INVALID_REQUEST", "missing tenant", retryable=False)
    return tenant


def empty_project(*, width: int = 1080, height: int = 1920, fps: int = 30) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "fps": fps,
        "compositionWidth": width,
        "compositionHeight": height,
        "tracks": [],
        "items": {},
        "assets": {},
        "deletedAssets": [],
        "shots": [],
    }


def production_request(
    pages: list[tuple[str, int]] | None = None,
    *,
    request_id: str = "req-1",
    project_limit: str = "100.00",
    shot_limit: str = "10.00",
    max_calls: int = 3,
    reading_direction: str = "ltr",
) -> ProductionRequest:
    sources = pages or [("https://cdn.example/page-1.png", 1)]
    return ProductionRequest(
        prod_client_request_id=request_id,
        contract_version=1,
        source_pages=[
            SourcePage(image_url=url, page_number=number)  # type: ignore[arg-type]
            for url, number in sources
        ],
        reading_direction=reading_direction,  # type: ignore[arg-type]
        output=OutputSpec(
            width=1080,
            height=1920,
            fps=30,
            language="zh",
            panel_fit_policy="blurred-background-contain",
        ),
        style=StyleSpec(motion_strength="subtle", subtitle_mode="clean-bubble-and-caption"),
        budget=BudgetSpec(
            project_limit_rmb=Decimal(project_limit),
            shot_limit_rmb=Decimal(shot_limit),
            max_paid_calls_per_shot=max_calls,
        ),
        default_voice_id="voice-default",
    )


class MemoryFetcher:
    def __init__(self, pages: dict[str, bytes]) -> None:
        self.pages = pages

    async def fetch(self, url: str) -> bytes:
        if url not in self.pages:
            raise ComicServiceError("INVALID_REQUEST", "image was not staged", retryable=False)
        return self.pages[url]


class ScriptedDetector:
    def __init__(self, fail_image: bytes | None = None) -> None:
        self.fail_image = fail_image
        self.calls = 0

    async def detect(
        self,
        *,
        page_id: str,
        image: bytes,
        reading_direction: str,
    ) -> PageDetection:
        del reading_direction
        self.calls += 1
        text = FAIL_LINE if image == self.fail_image else f"line {page_id[:8]}"
        return PageDetection(
            page_width=1000,
            page_height=1600,
            panels=(
                DetectedPanel(
                    x=50,
                    y=50,
                    width=900,
                    height=900,
                    confidence=0.9,
                    bubbles=(
                        DetectedBubble(
                            text=text,
                            confidence=0.95,
                            polygon=((10, 10), (80, 10), (80, 40), (10, 40)),
                        ),
                    ),
                    provider_id=f"provider-{self.calls}",
                ),
            ),
            raw={"providerId": f"provider-{self.calls}", "label": "page"},
        )


class ScriptedSpeech:
    def __init__(self) -> None:
        self.calls = 0
        self.accepted: dict[str, SpeechSynthesis] = {}
        self.fail_text = FAIL_LINE
        self.timeout_once = False
        self._timed_out = False

    async def synthesize(
        self,
        *,
        request_id: str,
        text: str,
        voice_id: str,
    ) -> SpeechSynthesis:
        del voice_id
        self.calls += 1
        speech = SpeechSynthesis(
            audio=text.encode(),
            duration_ms=800,
            provider_request_id=request_id,
            cost_fen=10,
            visemes=((0, "open"),),
        )
        if self.timeout_once and not self._timed_out:
            self._timed_out = True
            self.accepted[request_id] = speech
            raise ProviderTimeout(request_id)
        if text == self.fail_text:
            raise RuntimeError("tts provider failed")
        self.accepted[request_id] = speech
        return speech

    async def reconcile(self, request_id: str) -> SpeechSynthesis | None:
        return self.accepted.get(request_id)


class ScriptedRemotion:
    def __init__(self) -> None:
        self.create_calls = 0
        self.apply_calls: list[str] = []
        self.payloads: list[tuple[str, dict[str, Any]]] = []
        self.dialogue_checks: list[tuple[int, int]] = []
        self.render_batch_calls = 0
        self.preview_frame_calls = 0
        self.fail_once: set[tuple[str, int]] = set()
        self.on_preview_frame = None

    async def create_project(
        self,
        *,
        width: int,
        height: int,
        fps: int,
        client_request_id: str,
    ) -> dict[str, Any]:
        del client_request_id
        self.create_calls += 1
        return empty_project(width=width, height=height, fps=fps)

    async def apply(
        self,
        *,
        client_request_id: str,
        expected_revision: int,
        project: dict[str, Any],
        command_name: str,
        payload: dict[str, Any],
    ) -> ComposeResult:
        del client_request_id, expected_revision
        self.apply_calls.append(command_name)
        self.payloads.append((command_name, payload))
        updated = copy.deepcopy(project)
        if command_name == "image/sequence":
            _place_images(updated, payload)
        elif command_name == "dialogue/add":
            _place_dialogue(updated, payload["lines"], self.dialogue_checks)
        elif command_name == "dialogue/voice":
            updated.setdefault("assets", {})
            for voice in payload["voices"]:
                updated["assets"][f"voice:{voice['lineId']}"] = {"url": voice["audioUrl"]}
        elif command_name == "project/pad":
            _pad_project(updated, int(payload["minimumDurationInFrames"]))
        elif command_name == "shot/edit":
            updated["items"]["shot-edit"] = payload
        elif command_name == "layers/import":
            _import_layers(updated, payload["layerPackage"])
        elif command_name == "layers/restore-l0":
            _restore_l0(updated, str(payload["shotId"]))
        elif command_name == "item/motion":
            _apply_item_motion(updated, payload)
        else:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "unexpected compose command",
                retryable=False,
                details={"command": command_name},
            )
        return ComposeResult(project=updated, content_hash=project_content_hash(updated))

    async def validate_project(self, project: dict[str, Any]) -> ValidationReport:
        del project
        return ValidationReport(valid=True, issues=())

    async def summarize_project(self, project: dict[str, Any]) -> dict[str, Any]:
        return {"shotCount": len(project.get("shots") or [])}

    async def plan_batches(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        total = sum(int(shot["durationInFrames"]) for shot in project.get("shots") or [])
        if total <= 0:
            return []
        end = total - 1
        batch_id = project_content_hash(project)[:32]
        return [
            {
                "batchId": batch_id,
                "batchIndex": 0,
                "fromFrame": 0,
                "endFrameInclusive": end,
                "durationInFrames": total,
                "shotIds": [shot["id"] for shot in project["shots"]],
                "reason": "l0",
            }
        ]

    async def render_batches(
        self,
        project: dict[str, Any],
        *,
        retry_batch_ids: list[str],
    ) -> list[dict[str, Any]]:
        del project
        self.render_batch_calls += 1
        return [
            {
                "batchId": batch_id,
                "ok": True,
                "renderId": f"render-{batch_id[:12]}",
                "bucketName": "comic-renders",
            }
            for batch_id in retry_batch_ids
        ]

    async def render_progress(self, *, bucket_name: str, render_id: str) -> RenderProgress:
        del bucket_name, render_id
        return RenderProgress(status="done", progress=1, output_bytes=b"mp4-bytes")

    async def contact_sheet(self, project: dict[str, Any]):
        from novelcomic_agent.comic.rendering.remotion_client import ContactFrame

        shots = sorted(project.get("shots") or [], key=lambda shot: (shot["from"], shot["id"]))
        frames = []
        for shot in shots:
            frame = int(shot["from"]) + (int(shot["durationInFrames"]) - 1) // 2
            frames.append(ContactFrame(shot_id=str(shot["id"]), frame=frame))
        return frames

    async def preview_frame(self, project: dict[str, Any], *, frame: int, width: int = 480):
        from novelcomic_agent.comic.qa.contact_sheet import encode_png
        from novelcomic_agent.comic.rendering.remotion_client import StillFrame

        del width
        self.preview_frame_calls += 1
        if self.on_preview_frame is not None:
            await self.on_preview_frame(frame)
        shot_id = ""
        for shot in project.get("shots") or []:
            start = int(shot["from"])
            if start <= frame < start + int(shot["durationInFrames"]):
                shot_id = str(shot["id"])
                break
        key = (shot_id, frame)
        if key in self.fail_once:
            self.fail_once.remove(key)
            raise ComicServiceError("COMPOSE_FAILED", "preview frame failed", retryable=True)
        color = bytes((frame % 200, 40, 80))
        return StillFrame(body=encode_png(4, 4, color * 16), task_id=f"still-{frame}")

    async def export_package(
        self,
        *,
        project_id: str,
        project: dict[str, Any],
        batches: list[dict[str, Any]],
        files: list[dict[str, Any]],
    ) -> dict[str, Any]:
        del project
        return {
            "manifest": {
                "schemaVersion": 1,
                "projectId": project_id,
                "batches": batches,
                "files": files,
            }
        }


def _is_panel_track(track_id: str) -> bool:
    return track_id.endswith((":panel", ":panel-foreground", ":panel-background"))


def _place_images(project: dict[str, Any], payload: dict[str, Any]) -> None:
    images = payload["images"]
    cursor = 0
    shots = []
    tracks = [
        track
        for track in project.get("tracks") or []
        if not _is_panel_track(str(track.get("id", "")))
    ]
    assets = dict(project.get("assets") or {})
    items = dict(project.get("items") or {})
    for image in images:
        duration = int(image["durationInFrames"])
        shot_id = image["shotId"]
        asset_id = f"asset:{shot_id}:panel"
        item_id = f"item:{shot_id}:panel"
        track_id = f"track:{shot_id}:panel"
        assets[asset_id] = {
            "id": asset_id,
            "type": "image",
            "remoteUrl": image["url"],
        }
        items[item_id] = {
            "id": item_id,
            "type": "image",
            "assetId": asset_id,
            "from": cursor,
            "durationInFrames": duration,
            "shotId": shot_id,
            "layerId": "panel",
        }
        tracks.append(
            {
                "id": track_id,
                "items": [item_id],
                "hidden": False,
                "muted": False,
                "shotId": shot_id,
                "semantic": "background",
                "name": shot_id,
            }
        )
        if payload.get("panelFitPolicy") == "blurred-background-contain":
            foreground_item = f"item:{shot_id}:panel-foreground"
            background_item = f"item:{shot_id}:panel-background"
            foreground_track = f"track:{shot_id}:panel-foreground"
            background_track = f"track:{shot_id}:panel-background"
            items[foreground_item] = {
                "id": foreground_item,
                "type": "image",
                "assetId": asset_id,
                "fit": "contain",
                "role": "panel-foreground",
                "shotId": shot_id,
            }
            items[background_item] = {
                "id": background_item,
                "type": "image",
                "assetId": asset_id,
                "fit": "cover",
                "role": "panel-background",
                "blurRadiusPx": 28,
                "dimOpacity": 0.45,
                "shotId": shot_id,
            }
            tracks.append(
                {
                    "id": foreground_track,
                    "items": [foreground_item],
                    "hidden": False,
                    "muted": False,
                    "shotId": shot_id,
                    "semantic": "foreground",
                }
            )
            tracks.append(
                {
                    "id": background_track,
                    "items": [background_item],
                    "hidden": False,
                    "muted": False,
                    "shotId": shot_id,
                    "semantic": "background",
                }
            )
        shots.append(
            {
                "id": shot_id,
                "from": cursor,
                "durationInFrames": duration,
                "layerTrackIds": [track_id],
                "dialogueItemIds": [],
            }
        )
        cursor += duration
    project["shots"] = shots
    project["tracks"] = tracks
    project["assets"] = assets
    project["items"] = items


def _import_layers(project: dict[str, Any], package: dict[str, Any]) -> None:
    if package["diagnostics"].get("requiresFallback"):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "Layer package requires fallback",
            retryable=False,
            details={"shotId": package["shotId"]},
        )
    shot_id = package["shotId"]
    shots = project.get("shots") or []
    if not any(shot["id"] == shot_id for shot in shots):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "shot does not exist",
            retryable=False,
            details={"shotId": shot_id},
        )
    assets = project.setdefault("assets", {})
    items = project.setdefault("items", {})
    tracks = list(project.get("tracks") or [])
    imported: list[str] = []
    plain: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = {"eye": [], "mouth": []}
    for layer in package["layers"]:
        semantic = str(layer.get("semantic") or "")
        if semantic.startswith("eye-"):
            grouped["eye"].append(layer)
        elif semantic.startswith("mouth-"):
            grouped["mouth"].append(layer)
        else:
            plain.append(layer)
    for layer in plain:
        imported.append(_place_plain_layer(assets, items, tracks, shot_id, layer))
    shot_row = next(shot for shot in shots if shot["id"] == shot_id)
    for part, layers in grouped.items():
        if layers:
            imported.append(
                _place_sprite_group(assets, items, tracks, shot_row, part, layers)
            )
    for track in tracks:
        if track.get("id") in _plate_track_ids(shot_id):
            track["hidden"] = True
    for shot in shots:
        if shot["id"] == shot_id:
            rest = [
                track_id
                for track_id in shot.get("layerTrackIds") or []
                if track_id not in imported
            ]
            shot["layerTrackIds"] = [*imported, *rest]
    project["tracks"] = tracks


def _place_plain_layer(
    assets: dict[str, Any],
    items: dict[str, Any],
    tracks: list[dict[str, Any]],
    shot_id: str,
    layer: dict[str, Any],
) -> str:
    layer_id = layer["layerId"]
    asset_id = f"asset:{shot_id}:{layer_id}"
    item_id = f"item:{shot_id}:{layer_id}"
    track_id = f"track:{shot_id}:{layer_id}"
    assets[asset_id] = {"id": asset_id, "type": "image", "remoteUrl": layer["imageUrl"]}
    items[item_id] = {
        "id": item_id,
        "type": "image",
        "assetId": asset_id,
        "shotId": shot_id,
        "layerId": layer_id,
    }
    tracks[:] = [track for track in tracks if track.get("id") != track_id]
    tracks.append(
        {
            "id": track_id,
            "items": [item_id],
            "hidden": not layer.get("visible", True),
            "muted": False,
            "shotId": shot_id,
            "semantic": layer["semantic"],
            "name": layer.get("name") or layer_id,
        }
    )
    return track_id


_EYE_ORDER = ("eye-open", "eye-closed")
_MOUTH_ORDER = ("mouth-closed", "mouth-half", "mouth-open")


def _place_sprite_group(
    assets: dict[str, Any],
    items: dict[str, Any],
    tracks: list[dict[str, Any]],
    shot: dict[str, Any],
    part: str,
    layers: list[dict[str, Any]],
) -> str:
    order = _EYE_ORDER if part == "eye" else _MOUTH_ORDER
    ordered = sorted(layers, key=lambda layer: order.index(str(layer["semantic"])))
    shot_id = str(shot["id"])
    asset_ids = [
        f"asset:{shot_id}:{part}:{_sprite_token(part, str(layer['semantic']))}" for layer in ordered
    ]
    for layer, asset_id in zip(ordered, asset_ids, strict=True):
        assets[asset_id] = {
            "id": asset_id,
            "type": "image",
            "remoteUrl": layer["imageUrl"],
            "checksum": layer.get("checksum"),
        }
    item_id = f"item:{shot_id}:{part}"
    track_id = f"track:{shot_id}:{part}"
    previous = items.get(item_id) if isinstance(items.get(item_id), dict) else {}
    items[item_id] = {
        "id": item_id,
        "type": "image",
        "assetId": asset_ids[0],
        "spriteAssetIds": asset_ids,
        "shotId": shot_id,
        "layerId": part,
        "from": int(shot["from"]),
        "durationInFrames": int(shot["durationInFrames"]),
        "motion": previous.get("motion"),
    }
    tracks[:] = [track for track in tracks if track.get("id") != track_id]
    primary = ordered[0]
    tracks.append(
        {
            "id": track_id,
            "items": [item_id],
            "hidden": not primary.get("visible", True),
            "muted": False,
            "shotId": shot_id,
            "semantic": primary["semantic"],
            "name": primary.get("name") or part,
        }
    )
    return track_id


def _sprite_token(part: str, semantic: str) -> str:
    prefix = f"{part}-"
    if semantic.startswith(prefix):
        return semantic[len(prefix) :]
    return semantic


def _apply_item_motion(project: dict[str, Any], payload: dict[str, Any]) -> None:
    sprite = payload.get("sprite")
    target = payload["target"]
    if sprite is not None:
        if target.get("type") != "item" or any(
            payload.get(name) for name in ("parameters", "keyframes", "cameraKeyframes", "seed")
        ):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "sprite motion cannot include transform or camera fields",
                retryable=False,
            )
        item = (project.get("items") or {}).get(target["itemId"])
        if not isinstance(item, dict) or item.get("type") != "image":
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "sprite motion item is not an image",
                retryable=False,
                details={"itemId": target.get("itemId")},
            )
        asset_ids = _sprite_asset_ids(sprite)
        assets = project.get("assets") or {}
        for asset_id in asset_ids:
            asset = assets.get(asset_id)
            if not isinstance(asset, dict) or asset.get("type") != "image":
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "sprite asset is not an image",
                    retryable=False,
                    details={"assetId": asset_id, "itemId": item["id"]},
                )
        try:
            if sprite["kind"] == "blink":
                incoming = build_blink_sprite_states(
                    open_asset_id=sprite["openAssetId"],
                    closed_asset_id=sprite["closedAssetId"],
                    seed=int(sprite["seed"]),
                    duration_in_frames=int(item["durationInFrames"]),
                    fps=int(project.get("fps") or 30),
                )
            else:
                ranges = _dialogue_ranges(project, item, sprite["dialogueItemIds"])
                incoming = build_mouth_flap_sprite_states(
                    closed_asset_id=sprite["closedAssetId"],
                    open_asset_id=sprite["openAssetId"],
                    half_asset_id=sprite.get("halfAssetId"),
                    dialogue_ranges=ranges,
                    duration_in_frames=int(item["durationInFrames"]),
                    fps=int(project.get("fps") or 30),
                )
        except ValueError as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                str(exc),
                retryable=False,
                details={"itemId": item["id"]},
            ) from exc
        motion = dict(item.get("motion") or {})
        motion["spriteStates"] = _merge_sprite_states(
            list(motion.get("spriteStates") or []),
            incoming,
            str(payload.get("mode") or "replace"),
            str(item["id"]),
        )
        item["motion"] = motion
        item["spriteAssetIds"] = list(
            dict.fromkeys([*(item.get("spriteAssetIds") or []), *asset_ids])
        )
        return
    preset_id = target.get("presetId")
    if target.get("type") == "item":
        item = (project.get("items") or {}).get(target["itemId"])
        if not isinstance(item, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "motion item does not exist",
                retryable=False,
                details={"itemId": target.get("itemId")},
            )
        motion = dict(item.get("motion") or {})
        motion["preset"] = {"id": preset_id, "seed": payload.get("seed")}
        item["motion"] = motion
        return
    found = False
    for shot in project.get("shots") or []:
        if shot.get("id") == target.get("shotId"):
            shot["cameraPresetId"] = preset_id
            found = True
    if not found:
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "motion shot does not exist",
            retryable=False,
            details={"shotId": target.get("shotId")},
        )


def _sprite_asset_ids(sprite: dict[str, Any]) -> list[str]:
    if sprite["kind"] == "blink":
        return [sprite["openAssetId"], sprite["closedAssetId"]]
    return [
        asset_id
        for asset_id in (
            sprite["closedAssetId"],
            sprite.get("halfAssetId"),
            sprite["openAssetId"],
        )
        if asset_id
    ]


def _dialogue_ranges(
    project: dict[str, Any],
    item: dict[str, Any],
    dialogue_item_ids: list[str],
) -> list[tuple[int, int]]:
    if not dialogue_item_ids:
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "mouth flap requires at least one dialogue item",
            retryable=False,
            details={"itemId": item["id"]},
        )
    ranges: list[tuple[int, int]] = []
    for dialogue_item_id in dialogue_item_ids:
        dialogue = (project.get("items") or {}).get(dialogue_item_id)
        if not isinstance(dialogue, dict) or dialogue.get("type") != "captions":
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "dialogue item is not a caption",
                retryable=False,
                details={"itemId": dialogue_item_id},
            )
        ranges.append(
            (
                int(dialogue["from"]) - int(item["from"]),
                int(dialogue["durationInFrames"]),
            )
        )
    return ranges


def _merge_sprite_states(
    existing: list[dict[str, Any]],
    incoming: list[dict[str, Any]],
    mode: str,
    item_id: str,
) -> list[dict[str, Any]]:
    if mode == "replace":
        return [dict(state) for state in incoming]
    by_frame = {int(state["frame"]): dict(state) for state in existing}
    for state in incoming:
        current = by_frame.get(int(state["frame"]))
        if current is not None and current["assetId"] != state["assetId"]:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "sprite state frame conflicts with existing motion",
                retryable=False,
                details={"itemId": item_id},
            )
        by_frame[int(state["frame"])] = dict(state)
    return [by_frame[frame] for frame in sorted(by_frame)]


def _plate_track_ids(shot_id: str) -> set[str]:
    return {
        f"track:{shot_id}:panel",
        f"track:{shot_id}:panel-foreground",
        f"track:{shot_id}:panel-background",
    }


def _restore_l0(project: dict[str, Any], shot_id: str) -> None:
    asset_id = f"asset:{shot_id}:panel"
    item_ids = (f"item:{shot_id}:panel", f"item:{shot_id}:panel-foreground")
    assets = project.get("assets") or {}
    items = project.get("items") or {}
    plate_ids = _plate_track_ids(shot_id)
    if asset_id not in assets or not any(item_id in items for item_id in item_ids):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "L0 panel asset is missing",
            retryable=False,
            details={"shotId": shot_id, "assetId": asset_id},
        )
    found = False
    for track in project.get("tracks") or []:
        if track.get("id") in plate_ids:
            track["hidden"] = False
            found = True
        elif (
            track.get("shotId") == shot_id
            and track.get("id") not in plate_ids
            and track.get("semantic") != "dialogue"
        ):
            track["hidden"] = True
    if not found:
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "L0 panel track is missing",
            retryable=False,
            details={"shotId": shot_id},
        )


def _place_dialogue(
    project: dict[str, Any],
    lines: list[dict[str, Any]],
    checks: list[tuple[int, int]],
) -> None:
    shots = {shot["id"]: shot for shot in project.get("shots") or []}
    items = dict(project.get("items") or {})
    for line in lines:
        shot = shots[line["shotId"]]
        start = int(line["from"])
        end = start + int(line["durationInFrames"])
        shot_end = int(shot["from"]) + int(shot["durationInFrames"])
        if start < int(shot["from"]) or end > shot_end:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "dialogue frame is outside its shot",
                retryable=False,
                details={"shotId": line["shotId"], "from": start},
            )
        checks.append((int(shot["from"]), start))
        items[str(line["lineId"])] = {
            "from": start,
            "durationInFrames": line["durationInFrames"],
            "text": line["text"],
        }
        dialogue_id = f"dialogue:{line['shotId']}:{line['lineId']}"
        items[dialogue_id] = {
            "id": dialogue_id,
            "type": "captions",
            "from": start,
            "durationInFrames": int(line["durationInFrames"]),
            "shotId": line["shotId"],
            "text": line["text"],
        }
        if "visible" in line:
            items[dialogue_id]["visible"] = bool(line["visible"])
    project["items"] = items


def _pad_project(project: dict[str, Any], minimum: int) -> None:
    shots = project.get("shots") or []
    total = sum(int(shot["durationInFrames"]) for shot in shots)
    if shots and total < minimum:
        shots[-1]["durationInFrames"] += minimum - total
