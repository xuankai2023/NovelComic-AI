"""Stage D adds blink and mouth-flap on top of an accepted L1 plate."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from novelcomic_agent.comic.analyzer.panel_analyzer import DetectedPanel, PageDetection
from novelcomic_agent.comic.assets.l1_layer_service import (
    LayerProviderError,
    LayerSeparation,
    ProviderLayer,
)
from novelcomic_agent.comic.assets.l2_sprite_service import (
    L2SpriteService,
    ProviderSpriteState,
    ProviderTimeout,
    SpriteGeneration,
    SpriteProviderError,
)
from novelcomic_agent.comic.assets.sprite_quality_gate import (
    SpriteReference,
    evaluate_sprites,
)
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.contracts.layer_package import (
    Layer,
    LayerAnchor,
    LayerBounds,
    LayerCanvas,
    LayerDiagnostics,
    LayerPackage,
)
from novelcomic_agent.comic.contracts.sprite_state import (
    SpriteAssetSet,
    SpriteStateAsset,
    sprite_asset_id,
)
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.rendering.commands import compose_command
from novelcomic_agent.comic.rendering.motion_commands import (
    blink_motion_payload,
    blink_seed,
    mouth_motion_payload,
)
from novelcomic_agent.comic.rendering.remotion_client import RemotionHttpClient
from novelcomic_agent.comic.rendering.sprite_states import (
    build_blink_sprite_states,
    build_mouth_flap_sprite_states,
)
from novelcomic_agent.comic.stage_c import build_stage_c
from novelcomic_agent.comic.stage_d import build_stage_d
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    empty_project,
    page_png,
    production_request,
    tenant_from_header,
)

PAGE = "a" * 64
SHOT = f"shot:{PAGE}:0:part:0"
HOSTS = frozenset({"cdn.example", "objects.novelcomic.local"})
HASH = "ab" * 32
DIGEST = "cd" * 32
HEAD_URL = "https://cdn.example/head.png"
HEAD_DIGEST = "ef" * 32
HEAD_BOUNDS = (100.0, 200.0, 400.0, 400.0)


def _png(width: int = 400, height: int = 400, color_type: int = 6) -> bytes:
    raw = bytearray(32)
    raw[:8] = b"\x89PNG\r\n\x1a\n"
    raw[12:16] = b"IHDR"
    raw[16:20] = width.to_bytes(4, "big")
    raw[20:24] = height.to_bytes(4, "big")
    raw[24] = 8
    raw[25] = color_type
    return bytes(raw)


def _bounds(x: float = 100, y: float = 200, width: float = 400, height: float = 400) -> LayerBounds:
    return LayerBounds(x=x, y=y, width=width, height=height)


def _state(part: str, semantic: str, **overrides: object) -> SpriteStateAsset:
    values: dict[str, object] = {
        "shot_id": SHOT,
        "part": part,
        "semantic": semantic,
        "asset_id": sprite_asset_id(SHOT, part, semantic),
        "image_url": f"https://cdn.example/{part}-{semantic}.png",
        "width": 400,
        "height": 400,
        "bounds": _bounds(),
        "anchor": LayerAnchor(x=0.5, y=0.5),
        "checksum": DIGEST,
        "model_version": "sprite-v1",
        "input_hash": HASH,
        "color_type": 6,
    }
    values.update(overrides)
    return SpriteStateAsset(**values)  # type: ignore[arg-type]


def _asset_set(states: list[SpriteStateAsset], **overrides: object) -> SpriteAssetSet:
    values: dict[str, object] = {
        "project_id": "project-1",
        "shot_id": SHOT,
        "canvas": LayerCanvas(width=1080, height=1920),
        "reference_layer_id": "head",
        "states": states,
        "missing": [],
        "partial": False,
        "dialogue_present": True,
        "warnings": [],
    }
    values.update(overrides)
    return SpriteAssetSet(**values)  # type: ignore[arg-type]


def _reference() -> SpriteReference:
    return SpriteReference(
        canvas_width=1080,
        canvas_height=1920,
        bounds=HEAD_BOUNDS,
        anchor=(0.5, 0.5),
    )


def _checksums(asset_set: SpriteAssetSet, actual: str | None = None) -> dict[str, str]:
    return {
        str(state.image_url): state.checksum if actual is None else actual
        for state in asset_set.states
    }


def _face_package(*, head: bool = True, head_url: str = HEAD_URL) -> LayerPackage:
    layers = [
        Layer(
            layer_id="background",
            name="background",
            semantic="background",
            image_url="https://cdn.example/background.png",  # type: ignore[arg-type]
            z_index=0,
            visible=True,
            bounds=LayerBounds(x=0, y=0, width=1080, height=1920),
            anchor=LayerAnchor(x=0.5, y=0.5),
            confidence=1,
            motion_policy="static",
        )
    ]
    if head:
        layers.append(
            Layer(
                layer_id="head",
                name="head",
                semantic="head",
                image_url=head_url,  # type: ignore[arg-type]
                z_index=20,
                visible=True,
                bounds=_bounds(),
                anchor=LayerAnchor(x=0.5, y=0.5),
                confidence=1,
                motion_policy="subtle",
            )
        )
    return LayerPackage(
        project_id="project-1",
        shot_id=SHOT,  # type: ignore[arg-type]
        source_url="https://cdn.example/source.png",  # type: ignore[arg-type]
        canvas=LayerCanvas(width=1080, height=1920),
        layers=layers,
        diagnostics=LayerDiagnostics(
            recomposition_score=0,
            alpha_hole_ratio=0,
            edge_artifact_score=0,
            requires_fallback=False,
            warnings=[],
        ),
    )


class ScriptedSprites:
    def __init__(self) -> None:
        self.generate_calls = 0
        self.required: list[tuple[str, ...]] = []
        self.mode = "ok"
        self.stored: dict[str, SpriteGeneration] = {}
        self.reconcile_ready = True
        self.eye_bounds: tuple[float, float, float, float] | None = None
        self.mouth_bounds: tuple[float, float, float, float] | None = None

    def _states(self, required: tuple[str, ...]) -> tuple[ProviderSpriteState, ...]:
        states: list[ProviderSpriteState] = []
        for key in required:
            part, semantic = key.split(":")
            bounds = self.eye_bounds if part == "eye" else self.mouth_bounds
            color = 2 if self.mode == "opaque" and part == "eye" else 6
            states.append(
                ProviderSpriteState(part, semantic, _png(color_type=color), bounds=bounds)
            )
        if "mouth:closed" in required and self.mode != "missing-mouth":
            states.append(ProviderSpriteState("mouth", "half", _png(), bounds=self.mouth_bounds))
        if self.mode == "unknown":
            states.append(ProviderSpriteState("eye", "smile", _png()))
        if self.mode == "extra-mouth" and "mouth:closed" not in required:
            states.append(ProviderSpriteState("mouth", "open", _png()))
        if self.mode == "duplicate":
            states.append(ProviderSpriteState("eye", "open", _png()))
        return tuple(states)

    def _generation(self, request_id: str, required: tuple[str, ...]) -> SpriteGeneration:
        if self.mode == "empty":
            return SpriteGeneration(request_id, 20, ())
        missing: tuple[str, ...] = ()
        states = self._states(required)
        if self.mode == "missing-mouth":
            states = tuple(state for state in states if state.part != "mouth")
            missing = ("mouth:closed", "mouth:open")
        return SpriteGeneration(request_id, 20, states, missing=missing)

    async def generate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
        required_states: tuple[str, ...],
    ) -> SpriteGeneration:
        del shot_id, source_url, canvas_width, canvas_height, model_version, parameter_version
        self.generate_calls += 1
        self.required.append(required_states)
        result = self._generation(request_id, required_states)
        if self.mode == "timeout":
            self.stored[request_id] = result
            raise ProviderTimeout(request_id)
        if self.mode == "permanent":
            raise SpriteProviderError("provider-permanent", permanent=True)
        self.stored[request_id] = result
        return result

    async def reconcile(self, request_id: str) -> SpriteGeneration | None:
        if not self.reconcile_ready:
            return None
        return self.stored.get(request_id)


class HeadLayers:
    def __init__(self) -> None:
        self.separate_calls = 0
        self.fail_shot_id: str | None = None
        self.brake = False
        self.ledger: MemoryLedger | None = None
        self.production_id: str | None = None

    async def separate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
    ) -> LayerSeparation:
        del source_url, canvas_width, canvas_height, model_version, parameter_version
        self.separate_calls += 1
        if shot_id == self.fail_shot_id:
            raise LayerProviderError("provider-permanent", permanent=True)
        if self.brake and self.ledger is not None and self.production_id is not None:
            async with self.ledger.transaction() as session:
                row = await session.get_production(self.production_id)
                assert row is not None
                row.actual_cost_fen = 8000
                assert await session.save_production(row, expected_version=row.version) is not None
        return LayerSeparation(
            provider_request_id=request_id,
            cost_fen=20,
            layers=(
                ProviderLayer(
                    "background",
                    _png(1080, 1920),
                    z_index=0,
                    bounds=(0, 0, 1080, 1920),
                    motion_policy="static",
                ),
                ProviderLayer("head", _png(), z_index=20, bounds=HEAD_BOUNDS),
            ),
            recomposition_score=0.1,
            alpha_hole_ratio=0.01,
            edge_artifact_score=0.01,
        )

    async def reconcile(self, request_id: str) -> LayerSeparation | None:
        del request_id
        return None


class SilentDetector:
    def __init__(self) -> None:
        self.calls = 0

    async def detect(
        self,
        *,
        page_id: str,
        image: bytes,
        reading_direction: str,
    ) -> PageDetection:
        del page_id, image, reading_direction
        self.calls += 1
        return PageDetection(
            page_width=1000,
            page_height=1600,
            panels=(
                DetectedPanel(x=50, y=50, width=900, height=900, confidence=0.9, bubbles=()),
            ),
            raw={"providerId": "silent"},
        )


class _ConflictOnce(ScriptedRemotion):
    def __init__(self) -> None:
        super().__init__()
        self._failed = False

    async def apply(self, **kwargs: object):
        if kwargs["command_name"] == "item/motion" and not self._failed:
            self._failed = True
            self.apply_calls.append("item/motion")
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "stale revision",
                retryable=True,
            )
        return await super().apply(**kwargs)  # type: ignore[arg-type]


class _ConflictAlways(ScriptedRemotion):
    async def apply(self, **kwargs: object):
        if kwargs["command_name"] == "item/motion":
            self.apply_calls.append("item/motion")
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "stale revision",
                retryable=True,
            )
        return await super().apply(**kwargs)  # type: ignore[arg-type]


def _runtime(
    layers: HeadLayers,
    sprites: ScriptedSprites,
    remotion: ScriptedRemotion | None = None,
    **kwargs: object,
):
    pages = kwargs.pop("pages", None)
    page_list = pages if isinstance(pages, list) else [("https://cdn.example/page-1.png", 1)]
    images = {url: page_png(f"page-{number}") for url, number in page_list}
    detector = kwargs.pop("detector", None)
    return build_stage_d(
        ledger=MemoryLedger(),
        remotion=remotion or ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=detector if detector is not None else ScriptedDetector(),  # type: ignore[arg-type]
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=layers,
        sprite_provider=sprites,
        **kwargs,  # type: ignore[arg-type]
    ), page_list


async def _run(runtime, pages: list[tuple[str, int]] | None, request_id: str):
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request(pages, request_id=request_id),
    )
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    prepared = await runtime.assets.run(accepted.production_id)
    return accepted, prepared


def _assert_motion(project: dict, production_id: str, shot_id: str) -> None:
    eye = project["items"][f"item:{shot_id}:eye"]
    mouth = project["items"][f"item:{shot_id}:mouth"]
    fps = int(project["fps"])
    expected_eye = build_blink_sprite_states(
        open_asset_id=f"asset:{shot_id}:eye:open",
        closed_asset_id=f"asset:{shot_id}:eye:closed",
        seed=blink_seed(production_id, shot_id),
        duration_in_frames=int(eye["durationInFrames"]),
        fps=fps,
    )
    assert eye["motion"]["spriteStates"] == expected_eye
    assert all(0 <= state["frame"] < eye["durationInFrames"] for state in expected_eye)
    half = f"asset:{shot_id}:mouth:half"
    ranges = [
        (int(item["from"]) - int(mouth["from"]), int(item["durationInFrames"]))
        for item in project["items"].values()
        if isinstance(item, dict)
        and item.get("type") == "captions"
        and item.get("shotId") == shot_id
    ]
    expected_mouth = build_mouth_flap_sprite_states(
        closed_asset_id=f"asset:{shot_id}:mouth:closed",
        open_asset_id=f"asset:{shot_id}:mouth:open",
        half_asset_id=half if half in project["assets"] else None,
        dialogue_ranges=ranges,
        duration_in_frames=int(mouth["durationInFrames"]),
        fps=fps,
    )
    assert mouth["motion"]["spriteStates"] == expected_mouth
    assert all(0 <= state["frame"] < mouth["durationInFrames"] for state in expected_mouth)


async def _sprite_service(provider: ScriptedSprites, **request_kwargs: object):
    runtime = build_stage_c(
        ledger=MemoryLedger(),
        remotion=ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=HeadLayers(),
    )
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request(**request_kwargs),  # type: ignore[arg-type]
    )
    service = L2SpriteService(
        artifacts=runtime.artifacts,
        costs=runtime.base.costs,
        objects=runtime.objects,
        provider=provider,
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        project_id=accepted.project_id,
        provider_name="sprite-l2",
        model_version="sprite-v1",
        parameter_version="sprite-params-v1",
        allowed_hosts=HOSTS,
        worst_case_fen=100,
    )
    return runtime, accepted, service


def _prepare_kwargs(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "package": _face_package(),
        "l1_input_hash": HASH,
        "l1_checksums": {HEAD_URL: HEAD_DIGEST},
        "dialogues": (("line-1", 0, 12),),
    }
    values.update(overrides)
    return values


def test_gate_judges_blink_and_mouth_independently() -> None:
    eyes = _asset_set(
        [_state("eye", "open", color_type=2), _state("eye", "closed", color_type=2)],
        dialogue_present=False,
    )
    eye_only = evaluate_sprites(eyes, reference=_reference(), checksums=_checksums(eyes))
    assert eye_only.capabilities == ()
    assert eye_only.diagnostics["blink"] == "opaque-edge"
    assert eye_only.diagnostics["mouthFlap"] == "not-requested"

    both = _asset_set(
        [
            _state("eye", "open", color_type=2),
            _state("eye", "closed", color_type=2),
            _state("mouth", "closed"),
            _state("mouth", "open"),
        ]
    )
    split = evaluate_sprites(both, reference=_reference(), checksums=_checksums(both))
    assert split.capabilities == ("mouth-flap",)
    assert split.rejected_reasons == ("opaque-edge",)

    missing_mouth = _asset_set([_state("eye", "open"), _state("eye", "closed")])
    mouth_failed = evaluate_sprites(
        missing_mouth,
        reference=_reference(),
        checksums=_checksums(missing_mouth),
    )
    assert mouth_failed.capabilities == ("blink",)
    assert mouth_failed.rejected_reasons == ("missing-mouth-state",)


def test_gate_drift_boundary_is_inclusive_and_ordered() -> None:
    passed = _asset_set(
        [
            _state("eye", "open", bounds=_bounds(x=104)),
            _state("eye", "closed", anchor=LayerAnchor(x=0.52, y=0.5)),
        ],
        dialogue_present=False,
    )
    accepted = evaluate_sprites(passed, reference=_reference(), checksums=_checksums(passed))
    assert accepted.blink is True

    drifted = _asset_set(
        [_state("eye", "open", bounds=_bounds(x=105)), _state("eye", "closed")],
        dialogue_present=False,
    )
    contour = evaluate_sprites(drifted, reference=_reference(), checksums=_checksums(drifted))
    assert contour.diagnostics["blink"] == "contour-drift"

    anchored = _asset_set(
        [_state("eye", "open"), _state("eye", "closed", anchor=LayerAnchor(x=0.53, y=0.5))],
        dialogue_present=False,
    )
    anchor = evaluate_sprites(anchored, reference=_reference(), checksums=_checksums(anchored))
    assert anchor.diagnostics["blink"] == "anchor-drift"

    duplicated = _asset_set(
        [
            _state("eye", "open", color_type=2),
            _state("eye", "open", image_url="https://cdn.example/eye-open-copy.png"),
            _state("eye", "closed"),
        ],
        dialogue_present=False,
    )
    duplicate = evaluate_sprites(
        duplicated,
        reference=_reference(),
        checksums=_checksums(duplicated),
    )
    assert duplicate.diagnostics["blink"] == "duplicate-semantic"

    opaque = _asset_set(
        [_state("eye", "open", color_type=2), _state("eye", "closed")],
        dialogue_present=False,
    )
    assert evaluate_sprites(
        opaque, reference=_reference(), checksums=_checksums(opaque)
    ).diagnostics["blink"] == "opaque-edge"
    mismatched = _asset_set(
        [_state("eye", "open"), _state("eye", "closed")],
        dialogue_present=False,
    )
    assert (
        evaluate_sprites(
            mismatched,
            reference=_reference(),
            checksums=_checksums(mismatched, "ee" * 32),
        ).diagnostics["blink"]
        == "checksum-mismatch"
    )


def test_gate_keeps_optional_half_and_does_not_mutate_or_invent_mouth() -> None:
    with pytest.raises(ValidationError):
        _state("eye", "half")
    silent = _asset_set(
        [_state("eye", "open"), _state("eye", "closed")],
        dialogue_present=False,
    )
    before = silent.model_dump()
    first = evaluate_sprites(silent, reference=_reference(), checksums=_checksums(silent))
    second = evaluate_sprites(silent, reference=_reference(), checksums=_checksums(silent))
    assert silent.model_dump() == before
    assert first == second
    assert first.capabilities == ("blink",)
    assert first.diagnostics["mouthFlap"] == "not-requested"

    half_failed = _asset_set(
        [
            _state("eye", "open"),
            _state("eye", "closed"),
            _state("mouth", "closed"),
            _state("mouth", "open"),
            _state("mouth", "half", color_type=2),
        ]
    )
    judged = evaluate_sprites(
        half_failed,
        reference=_reference(),
        checksums=_checksums(half_failed),
    )
    assert judged.capabilities == ("blink", "mouth-flap")
    assert judged.mouth_semantics == ("closed", "open")
    assert "mouth-half-rejected" in judged.warnings
    assert "spriteStates" not in half_failed.wire()


def test_motion_identity_changes_with_the_dialogue_timeline() -> None:
    seed = blink_seed("prod-1", SHOT)
    assert seed == blink_seed("prod-1", SHOT)
    assert seed != blink_seed("prod-1", SHOT, "sprite-motion-v2")
    assert 1 <= seed < 2**31
    shared = {
        "shot_id": SHOT,
        "production_id": "prod-1",
        "asset_checksums": {sprite_asset_id(SHOT, "eye", "open"): DIGEST},
        "dialogues": [("line-1", 0, 10)],
        "shot_duration_in_frames": 90,
    }
    blink = blink_motion_payload(**shared)  # type: ignore[arg-type]
    assert blink["mode"] == "replace"
    assert blink["target"] == {"type": "item", "itemId": f"item:{SHOT}:eye"}
    assert blink["sprite"]["openAssetId"] == f"asset:{SHOT}:eye:open"
    assert blink["sprite"]["closedAssetId"] == f"asset:{SHOT}:eye:closed"
    assert blink["sprite"]["seed"] == seed
    assert "spriteStates" not in blink
    again = compose_command("project-1", "item/motion", blink_motion_payload(**shared))  # type: ignore[arg-type]
    assert compose_command("project-1", "item/motion", blink).command_id == again.command_id

    mouth = {
        "shot_id": SHOT,
        "line_ids": ["line-1"],
        "include_half": False,
        "asset_checksums": {sprite_asset_id(SHOT, "mouth", "closed"): DIGEST},
        "dialogues": [("line-1", 0, 10)],
        "shot_duration_in_frames": 90,
    }
    original = mouth_motion_payload(**mouth)  # type: ignore[arg-type]
    changed = mouth_motion_payload(**{**mouth, "dialogues": [("line-1", 0, 11)]})  # type: ignore[arg-type]
    assert original["sprite"]["dialogueItemIds"] == [f"dialogue:{SHOT}:line-1"]
    assert compose_command("project-1", "item/motion", original).command_id != compose_command(
        "project-1",
        "item/motion",
        changed,
    ).command_id


def test_blink_frames_are_deterministic_and_inside_the_shot() -> None:
    frames = build_blink_sprite_states(
        open_asset_id="open",
        closed_asset_id="closed",
        seed=42,
        duration_in_frames=90,
        fps=30,
    )
    assert frames == build_blink_sprite_states(
        open_asset_id="open",
        closed_asset_id="closed",
        seed=42,
        duration_in_frames=90,
        fps=30,
    )
    assert frames != build_blink_sprite_states(
        open_asset_id="open",
        closed_asset_id="closed",
        seed=43,
        duration_in_frames=90,
        fps=30,
    )
    assert all(0 <= frame["frame"] < 90 for frame in frames)
    assert any(frame["assetId"] == "closed" for frame in frames)


async def test_l2_reuses_cache_and_does_not_invent_missing_states() -> None:
    provider = ScriptedSprites()
    runtime, _accepted, service = await _sprite_service(provider, max_calls=8)
    first = await service.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    second = await service.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    assert first.asset_set is not None
    assert second.asset_set is not None
    assert provider.generate_calls == 1
    assert "spriteStates" not in first.asset_set.wire()
    row = await runtime.productions.get_row(_accepted.production_id)
    assert row.actual_cost_fen == 20

    provider.mode = "missing-mouth"
    other = await service.prepare_shot(
        **_prepare_kwargs(l1_input_hash="12" * 32)  # type: ignore[arg-type]
    )
    assert other.asset_set is not None
    assert "mouth:open" in other.asset_set.missing
    assert "mouth:closed" in other.asset_set.missing
    assert all(state.part != "mouth" for state in other.asset_set.states)
    assert provider.generate_calls == 2

    provider.mode = "unknown"
    unknown = await service.prepare_shot(
        **_prepare_kwargs(l1_input_hash="34" * 32)  # type: ignore[arg-type]
    )
    assert unknown.asset_set is not None
    assert "unknown-semantic" in unknown.warnings
    assert {state.semantic for state in unknown.asset_set.states if state.part == "eye"} == {
        "open",
        "closed",
    }

    provider.mode = "extra-mouth"
    silent = await service.prepare_shot(
        **_prepare_kwargs(l1_input_hash="56" * 32, dialogues=())  # type: ignore[arg-type]
    )
    assert provider.required[-1] == ("eye:open", "eye:closed")
    assert silent.asset_set is not None
    assert silent.asset_set.dialogue_present is False
    assert all(state.part != "mouth" for state in silent.asset_set.states)

    provider.mode = "duplicate"
    duplicated = await service.prepare_shot(
        **_prepare_kwargs(l1_input_hash="78" * 32, dialogues=())  # type: ignore[arg-type]
    )
    assert duplicated.asset_set is not None
    assert "eye:open" in duplicated.asset_set.missing
    assert "duplicate-semantic" in duplicated.warnings


async def test_l2_timeout_reconciles_and_budget_stops_before_the_provider() -> None:
    provider = ScriptedSprites()
    provider.mode = "timeout"
    provider.reconcile_ready = False
    _runtime, _accepted, service = await _sprite_service(provider)
    pending = await service.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    assert pending.pending is True
    assert provider.generate_calls == 1
    provider.reconcile_ready = True
    provider.mode = "ok"
    recovered = await service.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    assert recovered.asset_set is not None
    assert provider.generate_calls == 1

    stopped_provider = ScriptedSprites()
    stopped_runtime, stopped_row, stopped = await _sprite_service(stopped_provider)
    async with stopped_runtime.ledger.transaction() as session:
        row = await session.get_production(stopped_row.production_id)
        assert row is not None
        row.actual_cost_fen = 8000
        assert await session.save_production(row, expected_version=row.version) is not None
    blocked = await stopped.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    assert blocked.downgrade_reason == "enhancement-budget-stopped"
    assert stopped_provider.generate_calls == 0

    limited = ScriptedSprites()
    _limited_runtime, _limited_row, limited_service = await _sprite_service(
        limited,
        request_id="budget",
        max_calls=0,
    )
    exceeded = await limited_service.prepare_shot(**_prepare_kwargs())  # type: ignore[arg-type]
    assert exceeded.downgrade_reason == "budget-exceeded"
    assert limited.generate_calls == 0

    missing_face = ScriptedSprites()
    _face_runtime, _face_row, face_service = await _sprite_service(
        missing_face,
        request_id="face",
    )
    no_face = await face_service.prepare_shot(
        **_prepare_kwargs(package=_face_package(head=False))  # type: ignore[arg-type]
    )
    assert no_face.downgrade_reason == "missing-face"
    assert missing_face.generate_calls == 0


async def test_l2_commits_blink_and_mouth_and_replay_does_not_pay_again() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = ScriptedRemotion()
    runtime, pages = _runtime(layers, sprites, remotion)
    accepted, prepared = await _run(runtime, pages, "l2")
    assert prepared.state is ProductionState.COMPOSING
    fact = (await runtime.productions.get_row(accepted.production_id)).stage_facts
    stage = fact["PREPARING_ASSETS"]
    shot = stage["shots"][0]
    assert stage["level"] == "L2"
    assert stage["strategyVersion"] == "sprite-motion-v1"
    assert shot["effectiveAnimationLevel"] == "L2"
    assert shot["capabilities"] == ["blink", "mouth-flap"]
    assert shot["downgradeReason"] is None
    assert "L3" not in shot["capabilities"]
    draft = await runtime.drafts.get(accepted.project_id)
    _assert_motion(draft.project, accepted.production_id, shot["shotId"])
    assert f"asset:{shot['shotId']}:eye:open" in draft.project["assets"]
    assert f"asset:{shot['shotId']}:mouth:closed" in draft.project["assets"]
    assert remotion.apply_calls.count("item/motion") == 2
    assert remotion.apply_calls.count("dialogue/add") == 1
    assert sprites.generate_calls == 1
    imported = [payload for name, payload in remotion.payloads if name == "layers/import"]
    assert all("spriteStates" not in str(payload) for payload in imported)

    calls = list(remotion.apply_calls)
    revision = draft.revision
    again = await runtime.assets.run(accepted.production_id)
    assert again.state is ProductionState.COMPOSING
    assert sprites.generate_calls == 1
    assert layers.separate_calls == 1
    assert remotion.apply_calls == calls
    replayed = await runtime.drafts.get(accepted.project_id)
    assert replayed.revision == revision
    blink = next(
        payload
        for name, payload in remotion.payloads
        if name == "item/motion" and payload["sprite"]["kind"] == "blink"
    )
    command = compose_command(accepted.project_id, "item/motion", blink)
    assert command.command_id == shot["motionCommands"][0]["commandId"]
    await runtime.applier.apply(command)
    assert (await runtime.drafts.get(accepted.project_id)).revision == revision
    assert remotion.apply_calls == calls

    tool = await runtime.motions.apply(
        "tenant-a",
        accepted.production_id,
        shot_id=shot["shotId"],
        expected_revision=revision,
        sprite="blink",
    )
    assert tool["commandId"] == command.command_id
    assert tool["effectiveLevel"] == "L2"
    assert (await runtime.drafts.get(accepted.project_id)).revision == revision

    delivered = await runtime.render.run(accepted.production_id)
    assert delivered.state is ProductionState.DELIVERED
    assert remotion.apply_calls.count("item/motion") == 2
    assert remotion.apply_calls.count("dialogue/add") == 1
    assert sprites.generate_calls == 1
    final = await runtime.productions.get_row(accepted.production_id)
    assert final.state != ProductionState.PERMANENT_FAILED.value


async def test_motion_tool_rejects_append_on_sprites_and_unbound_targets() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = ScriptedRemotion()
    runtime, pages = _runtime(layers, sprites, remotion)
    accepted, _prepared = await _run(runtime, pages, "tool")
    shot_id = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]["shots"][0]["shotId"]
    draft = await runtime.drafts.get(accepted.project_id)
    with pytest.raises(ComicServiceError) as append_sprite:
        await runtime.motions.apply(
            "tenant-a",
            accepted.production_id,
            shot_id=shot_id,
            expected_revision=draft.revision,
            sprite="blink",
            mode="append",
        )
    assert append_sprite.value.code == "INVALID_REQUEST"

    breathing = await runtime.motions.apply(
        "tenant-a",
        accepted.production_id,
        shot_id=shot_id,
        expected_revision=draft.revision,
        preset_id="breathing",
        item_id=f"item:{shot_id}:panel",
        mode="append",
    )
    moved = await runtime.drafts.get(accepted.project_id)
    assert moved.revision == breathing["revision"]
    assert moved.revision == draft.revision + 1
    replayed = await runtime.motions.apply(
        "tenant-a",
        accepted.production_id,
        shot_id=shot_id,
        expected_revision=moved.revision,
        preset_id="breathing",
        item_id=f"item:{shot_id}:panel",
        mode="append",
    )
    assert replayed["revision"] == breathing["revision"]
    assert (await runtime.drafts.get(accepted.project_id)).revision == moved.revision

    camera = await runtime.motions.apply(
        "tenant-a",
        accepted.production_id,
        shot_id=shot_id,
        expected_revision=moved.revision,
        preset_id="camera-push",
    )
    after_camera = await runtime.drafts.get(accepted.project_id)
    assert after_camera.revision == camera["revision"]
    assert after_camera.project["shots"][0]["cameraPresetId"] == "camera-push"
    with pytest.raises(ComicServiceError) as append_camera:
        await runtime.motions.apply(
            "tenant-a",
            accepted.production_id,
            shot_id=shot_id,
            expected_revision=after_camera.revision,
            preset_id="camera-push",
            mode="append",
        )
    assert append_camera.value.code == "INVALID_REQUEST"

    with pytest.raises(ComicServiceError) as other_tenant:
        await runtime.motions.apply(
            "tenant-b",
            accepted.production_id,
            shot_id=shot_id,
            expected_revision=after_camera.revision,
            sprite="blink",
        )
    assert other_tenant.value.code == "INVALID_REQUEST"
    with pytest.raises(ComicServiceError) as missing_shot:
        await runtime.motions.apply(
            "tenant-a",
            accepted.production_id,
            shot_id=f"shot:{'b' * 64}:0:part:0",
            expected_revision=after_camera.revision,
            sprite="blink",
        )
    assert missing_shot.value.code == "INVALID_REQUEST"

    fresh_layers = HeadLayers()
    fresh_sprites = ScriptedSprites()
    fresh, fresh_pages = _runtime(fresh_layers, fresh_sprites)
    fresh_accepted = await fresh.service.accept(
        "tenant-a",
        production_request(fresh_pages, request_id="unbound"),
    )
    await fresh.analyze.run(fresh_accepted.production_id)
    await fresh.voice.run(fresh_accepted.production_id)
    voice = (await fresh.productions.get_row(fresh_accepted.production_id)).stage_facts
    unbound = voice["SYNTHESIZING_VOICE"]["shots"][0]["shot_id"]
    current = await fresh.drafts.get(fresh_accepted.project_id)
    with pytest.raises(ComicServiceError) as missing_asset:
        await fresh.motions.apply(
            "tenant-a",
            fresh_accepted.production_id,
            shot_id=unbound,
            expected_revision=current.revision,
            sprite="blink",
        )
    assert missing_asset.value.code == "INVALID_REQUEST"
    assert fresh_sprites.generate_calls == 0


async def test_one_capability_can_fail_without_dropping_the_other() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    sprites.eye_bounds = (160, 200, 400, 400)
    runtime, pages = _runtime(layers, sprites)
    accepted, prepared = await _run(runtime, pages, "eye-drift")
    shot = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]["shots"][0]
    assert prepared.state is ProductionState.COMPOSING
    assert shot["effectiveAnimationLevel"] == "L2"
    assert shot["capabilities"] == ["mouth-flap"]
    assert shot["downgradeReason"] == "contour-drift"
    draft = await runtime.drafts.get(accepted.project_id)
    assert f"item:{shot['shotId']}:eye" not in draft.project["items"]
    assert draft.project["items"][f"item:{shot['shotId']}:mouth"]["motion"]["spriteStates"]

    mouth_layers = HeadLayers()
    mouth_sprites = ScriptedSprites()
    mouth_sprites.mouth_bounds = (100, 260, 400, 400)
    mouth_runtime, mouth_pages = _runtime(mouth_layers, mouth_sprites)
    mouth_accepted, _mouth_prepared = await _run(mouth_runtime, mouth_pages, "mouth-drift")
    mouth_row = await mouth_runtime.productions.get_row(mouth_accepted.production_id)
    mouth_shot = mouth_row.stage_facts["PREPARING_ASSETS"]["shots"][0]
    assert mouth_shot["capabilities"] == ["blink"]
    assert mouth_shot["downgradeReason"] == "contour-drift"
    mouth_draft = await mouth_runtime.drafts.get(mouth_accepted.project_id)
    assert f"item:{mouth_shot['shotId']}:mouth" not in mouth_draft.project["items"]
    eye_item = mouth_draft.project["items"][f"item:{mouth_shot['shotId']}:eye"]
    assert eye_item["motion"]["spriteStates"]

    both_layers = HeadLayers()
    both_sprites = ScriptedSprites()
    both_sprites.eye_bounds = (160, 200, 400, 400)
    both_sprites.mouth_bounds = (100, 260, 400, 400)
    both_remotion = ScriptedRemotion()
    both_runtime, both_pages = _runtime(both_layers, both_sprites, both_remotion)
    both_accepted, _both_prepared = await _run(both_runtime, both_pages, "both-drift")
    both = (await both_runtime.productions.get_row(both_accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]
    assert both["level"] == "L1"
    assert both["shots"][0]["capabilities"] == []
    assert both["shots"][0]["downgradeReason"] == "contour-drift"
    assert both_remotion.apply_calls.count("item/motion") == 0


async def test_l1_failure_and_flags_never_call_the_sprite_provider() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = ScriptedRemotion()
    runtime, pages = _runtime(layers, sprites, remotion)
    accepted = await runtime.service.accept("tenant-a", production_request(pages, request_id="l0"))
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    layers.fail_shot_id = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "SYNTHESIZING_VOICE"
    ]["shots"][0]["shot_id"]
    prepared = await runtime.assets.run(accepted.production_id)
    stored = await runtime.productions.get_row(accepted.production_id)
    fact = stored.stage_facts["PREPARING_ASSETS"]
    assert prepared.state is ProductionState.COMPOSING
    assert fact["level"] == "L0"
    assert fact["shots"][0]["effectiveAnimationLevel"] == "L0"
    assert sprites.generate_calls == 0
    assert remotion.apply_calls.count("item/motion") == 0

    flagged_layers = HeadLayers()
    flagged_sprites = ScriptedSprites()
    flagged_remotion = ScriptedRemotion()
    flagged, flagged_pages = _runtime(
        flagged_layers,
        flagged_sprites,
        flagged_remotion,
        l2_enabled=False,
    )
    flagged_accepted, flagged_prepared = await _run(flagged, flagged_pages, "flag-off")
    flagged_fact = (await flagged.productions.get_row(flagged_accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]
    assert flagged_prepared.state is ProductionState.COMPOSING
    assert flagged_fact["level"] == "L1"
    assert "strategyVersion" not in flagged_fact
    assert flagged_sprites.generate_calls == 0
    assert flagged_remotion.apply_calls.count("item/motion") == 0

    tenant_layers = HeadLayers()
    tenant_sprites = ScriptedSprites()
    tenant_runtime, tenant_pages = _runtime(
        tenant_layers,
        tenant_sprites,
        l2_tenants=frozenset({"tenant-b"}),
    )
    tenant_accepted, _tenant_prepared = await _run(tenant_runtime, tenant_pages, "tenant")
    tenant_row = await tenant_runtime.productions.get_row(tenant_accepted.production_id)
    tenant_fact = tenant_row.stage_facts["PREPARING_ASSETS"]
    assert tenant_fact["level"] == "L1"
    assert tenant_sprites.generate_calls == 0


async def test_silent_shot_blinks_without_mouth_or_dialogue() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = ScriptedRemotion()
    runtime, pages = _runtime(layers, sprites, remotion, detector=SilentDetector())
    accepted, prepared = await _run(runtime, pages, "silent")
    shot = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]["shots"][0]
    assert prepared.state is ProductionState.COMPOSING
    assert shot["capabilities"] == ["blink"]
    assert shot["effectiveAnimationLevel"] == "L2"
    assert sprites.required == [("eye:open", "eye:closed")]
    assert remotion.apply_calls.count("dialogue/add") == 0
    assert remotion.apply_calls.count("item/motion") == 1
    draft = await runtime.drafts.get(accepted.project_id)
    assert f"item:{shot['shotId']}:mouth" not in draft.project["items"]
    eye = draft.project["items"][f"item:{shot['shotId']}:eye"]
    assert eye["motion"]["spriteStates"] == build_blink_sprite_states(
        open_asset_id=f"asset:{shot['shotId']}:eye:open",
        closed_asset_id=f"asset:{shot['shotId']}:eye:closed",
        seed=blink_seed(accepted.production_id, shot["shotId"]),
        duration_in_frames=int(eye["durationInFrames"]),
        fps=int(draft.project["fps"]),
    )


async def test_one_shot_failure_does_not_redo_the_other() -> None:
    pages = [("https://cdn.example/page-1.png", 1), ("https://cdn.example/page-2.png", 2)]
    layers = HeadLayers()
    sprites = ScriptedSprites()
    runtime, _pages = _runtime(layers, sprites, pages=pages)
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request(pages, request_id="mixed"),
    )
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    layers.fail_shot_id = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "SYNTHESIZING_VOICE"
    ]["shots"][1]["shot_id"]
    prepared = await runtime.assets.run(accepted.production_id)
    stored = await runtime.productions.get_row(accepted.production_id)
    fact = stored.stage_facts["PREPARING_ASSETS"]
    levels = {shot["effectiveAnimationLevel"] for shot in fact["shots"]}
    assert prepared.state is ProductionState.COMPOSING
    assert levels == {"L0", "L2"}
    assert fact["level"] == "mixed"
    assert sprites.generate_calls == 1
    assert layers.separate_calls == 2
    calls = sprites.generate_calls
    again = await runtime.assets.run(accepted.production_id)
    assert again.state is ProductionState.COMPOSING
    assert sprites.generate_calls == calls
    assert layers.separate_calls == 2


async def test_cas_conflict_replays_motion_without_a_second_payment() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = _ConflictOnce()
    runtime, pages = _runtime(layers, sprites, remotion)
    accepted, prepared = await _run(runtime, pages, "cas-once")
    shot = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]["shots"][0]
    assert prepared.state is ProductionState.COMPOSING
    assert shot["effectiveAnimationLevel"] == "L2"
    assert remotion.apply_calls.count("item/motion") == 3
    assert sprites.generate_calls == 1

    stuck_layers = HeadLayers()
    stuck_sprites = ScriptedSprites()
    stuck_remotion = _ConflictAlways()
    stuck, stuck_pages = _runtime(stuck_layers, stuck_sprites, stuck_remotion)
    stuck_accepted, stuck_prepared = await _run(stuck, stuck_pages, "cas-stuck")
    assert stuck_prepared.state is ProductionState.PREPARING_ASSETS
    stuck_facts = (await stuck.productions.get_row(stuck_accepted.production_id)).stage_facts
    assert "PREPARING_ASSETS" not in stuck_facts
    assert stuck_prepared.state is not ProductionState.PERMANENT_FAILED
    paid = stuck_sprites.generate_calls
    assert paid == 1
    replayed = await stuck.assets.run(stuck_accepted.production_id)
    assert replayed.state is ProductionState.PREPARING_ASSETS
    assert stuck_sprites.generate_calls == paid
    assert "PREPARING_ASSETS" not in (
        await stuck.productions.get_row(stuck_accepted.production_id)
    ).stage_facts


async def test_enhancement_brake_stays_on_l1() -> None:
    layers = HeadLayers()
    sprites = ScriptedSprites()
    remotion = ScriptedRemotion()
    runtime, pages = _runtime(layers, sprites, remotion)
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request(pages, request_id="brake"),
    )
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    layers.ledger = runtime.ledger
    layers.production_id = accepted.production_id
    layers.brake = True
    prepared = await runtime.assets.run(accepted.production_id)
    shot = (await runtime.productions.get_row(accepted.production_id)).stage_facts[
        "PREPARING_ASSETS"
    ]["shots"][0]
    assert prepared.state is ProductionState.COMPOSING
    assert shot["effectiveAnimationLevel"] == "L1"
    assert shot["downgradeReason"] == "enhancement-budget-stopped"
    assert sprites.generate_calls == 0
    assert remotion.apply_calls.count("item/motion") == 0


async def test_item_motion_posts_to_the_compose_route() -> None:
    import httpx

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"type": "success", "project": empty_project()})

    client = RemotionHttpClient(
        "http://remotion.test",
        allowed_hosts=HOSTS,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )
    await client.apply(
        client_request_id="compose:item/motion:1",  # type: ignore[arg-type]
        expected_revision=1,
        project=empty_project(),
        command_name="item/motion",
        payload={"mode": "replace", "target": {"type": "item", "itemId": "item:1"}},
    )
    await client.aclose()
    assert seen == ["/api/compose/item/motion"]
