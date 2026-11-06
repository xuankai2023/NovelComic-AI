"""Stage C keeps a playable L0 plate when L1 separation fails."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from novelcomic_agent.comic.assets.l0_panel import (
    describe_l0_panel,
    l0_asset_id,
    l0_asset_retained,
    l0_item_id,
    l0_sequence_payload,
    l0_track_id,
    register_l0_panel,
    shot_needs_l0_restore,
    shot_plates,
)
from novelcomic_agent.comic.assets.l1_layer_service import (
    L1LayerService,
    LayerProviderError,
    LayerSeparation,
    ProviderLayer,
    ProviderTimeout,
    layer_input_hash,
)
from novelcomic_agent.comic.assets.layer_quality_gate import (
    LayerGateThresholds,
    evaluate_layers,
)
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.contracts.layer_package import (
    Layer,
    LayerAnchor,
    LayerBounds,
    LayerCanvas,
    LayerDiagnostics,
    LayerPackage,
    package_input_hash,
)
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.rendering.commands import compose_command
from novelcomic_agent.comic.rendering.remotion_client import RemotionHttpClient
from novelcomic_agent.comic.repositories.artifact_repository import ArtifactRepository
from novelcomic_agent.comic.stage_c import build_stage_c
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
CANVAS = (1080, 1920)


def _png(color_type: int = 6) -> bytes:
    raw = bytearray(32)
    raw[:8] = b"\x89PNG\r\n\x1a\n"
    raw[12:16] = b"IHDR"
    raw[16:20] = (8).to_bytes(4, "big")
    raw[20:24] = (8).to_bytes(4, "big")
    raw[24] = 8
    raw[25] = color_type
    return bytes(raw)


def _layer(semantic: str, z_index: int, **updates: object) -> Layer:
    bounds = updates.pop("bounds", None)
    return Layer(
        layer_id=semantic,
        name=semantic,
        semantic=semantic,  # type: ignore[arg-type]
        image_url="https://cdn.example/layer.png",  # type: ignore[arg-type]
        z_index=z_index,
        visible=True,
        bounds=bounds
        if isinstance(bounds, LayerBounds)
        else LayerBounds(x=0, y=0, width=1080, height=1920),
        anchor=LayerAnchor(x=0.5, y=0.5),
        confidence=0.9,
        motion_policy="static" if semantic == "background" else "subtle",
        **updates,  # type: ignore[arg-type]
    )


def _package(**updates: object) -> LayerPackage:
    diagnostics = updates.pop("diagnostics", None)
    layers = updates.pop("layers", None)
    canvas = updates.pop("canvas", None)
    return LayerPackage(
        project_id="project-1",
        shot_id=SHOT,  # type: ignore[arg-type]
        source_url="https://cdn.example/source.png",  # type: ignore[arg-type]
        canvas=canvas if isinstance(canvas, LayerCanvas) else LayerCanvas(width=1080, height=1920),
        layers=layers
        if isinstance(layers, list)
        else [_layer("background", 0), _layer("body", 10)],
        diagnostics=diagnostics
        if isinstance(diagnostics, LayerDiagnostics)
        else LayerDiagnostics(
            recomposition_score=0.1,
            alpha_hole_ratio=0.01,
            edge_artifact_score=0.01,
            requires_fallback=False,
            warnings=[],
        ),
        **updates,  # type: ignore[arg-type]
    )


def _checksums(package: LayerPackage, actual: str | None = "ab" * 32) -> dict[str, str | None]:
    return {str(layer.image_url): actual for layer in package.layers}


def _separation(
    request_id: str,
    layers: tuple[ProviderLayer, ...] | None = None,
    **scores: float,
) -> LayerSeparation:
    image = _png()
    body = layers or (
        ProviderLayer(
            "background",
            image,
            z_index=0,
            bounds=(0, 0, 1080, 1920),
            motion_policy="static",
        ),
        ProviderLayer("body", image, z_index=10, bounds=(100, 200, 400, 800)),
    )
    return LayerSeparation(
        provider_request_id=request_id,
        cost_fen=20,
        layers=body,
        recomposition_score=scores.get("recomposition_score", 0.1),
        alpha_hole_ratio=scores.get("alpha_hole_ratio", 0.01),
        edge_artifact_score=scores.get("edge_artifact_score", 0.01),
    )


class ScriptedLayers:
    def __init__(self) -> None:
        self.separate_calls = 0
        self.fail_shot_id: str | None = None
        self.mode = "ok"
        self.stored: dict[str, LayerSeparation] = {}
        self.reconcile_ready = True
        self.block = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()

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
        if self.block:
            self.started.set()
            await self.release.wait()
        result = _separation(request_id)
        if self.mode == "partial":
            result = _separation(request_id, (result.layers[0],))
        elif self.mode == "duplicate":
            result = _separation(
                request_id,
                (
                    ProviderLayer("body", _png(), z_index=10, bounds=(0, 0, 100, 100)),
                    ProviderLayer("body", _png(), z_index=11, bounds=(0, 0, 100, 100)),
                ),
            )
        elif self.mode == "corrupt":
            result = _separation(
                request_id,
                (
                    result.layers[0],
                    ProviderLayer("body", b"not-a-png", z_index=10, bounds=(0, 0, 100, 100)),
                ),
            )
        elif self.mode == "hole":
            result = _separation(request_id, alpha_hole_ratio=0.4)
        if self.mode == "timeout":
            self.stored[request_id] = result
            raise ProviderTimeout(request_id)
        if shot_id == self.fail_shot_id:
            raise LayerProviderError("provider-permanent", permanent=True)
        self.stored[request_id] = result
        return result

    async def reconcile(self, request_id: str) -> LayerSeparation | None:
        if not self.reconcile_ready:
            return None
        return self.stored.get(request_id)


def _runtime(provider: ScriptedLayers, remotion: ScriptedRemotion | None = None):
    return build_stage_c(
        ledger=MemoryLedger(),
        remotion=remotion or ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher({}),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=provider,
    )


async def _accepted(runtime):
    accepted = await runtime.service.accept("tenant-a", production_request())
    service = L1LayerService(
        artifacts=runtime.artifacts,
        costs=runtime.base.costs,
        objects=runtime.objects,
        provider=runtime.layers._provider,
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        project_id=accepted.project_id,
        provider_name="layer-l1",
        model_version="layer-v1",
        parameter_version="params-v1",
        allowed_hosts=HOSTS,
        worst_case_fen=100,
    )
    return accepted, service


def test_l0_describes_extreme_frames_without_rendering_pixels() -> None:
    wide = describe_l0_panel(
        shot_id=SHOT,
        panel_url="https://cdn.example/wide.png",
        source_width=4000,
        source_height=200,
        canvas_width=1080,
        canvas_height=1920,
        full_page_fallback=False,
    )
    tall = describe_l0_panel(
        shot_id=SHOT,
        panel_url="https://cdn.example/tall.png",
        source_width=200,
        source_height=4000,
        canvas_width=1080,
        canvas_height=1920,
        full_page_fallback=True,
    )
    assert wide.fit.policy == "blurred-background-contain"
    assert wide.fit.foreground.width == 1080
    assert wide.fit.foreground.height < 1920
    assert wide.fit.background.height == 1920
    assert wide.fit.background.width > 1080
    assert tall.fit.foreground.height == 1920
    assert tall.fit.foreground.width < 1080
    assert tall.fit.background.width == 1080
    assert tall.fit.background.height > 1920
    described = tall.as_dict()
    assert described["fullPageFallback"] is True
    assert described["visible"] is True
    assert "pixels" not in described
    assert all(not isinstance(value, bytes) for value in described.values())


def test_l0_restore_sees_a_hidden_plate_and_a_visible_enhancement() -> None:
    hidden = {
        "tracks": [{"id": l0_track_id(SHOT), "hidden": True, "semantic": "background"}],
        "assets": {l0_asset_id(SHOT): {"id": l0_asset_id(SHOT)}},
        "items": {l0_item_id(SHOT): {"id": l0_item_id(SHOT)}},
    }
    assert shot_needs_l0_restore(hidden, SHOT)
    assert l0_asset_retained(hidden, SHOT)
    visible = {
        "tracks": [{"id": l0_track_id(SHOT), "hidden": False, "semantic": "background"}],
        "assets": hidden["assets"],
        "items": hidden["items"],
    }
    assert shot_needs_l0_restore(visible, SHOT) is False


async def test_l0_registration_is_idempotent() -> None:
    artifacts = ArtifactRepository(MemoryLedger())
    record = describe_l0_panel(
        shot_id=SHOT,
        panel_url="https://cdn.example/panel.png",
        source_width=900,
        source_height=900,
        canvas_width=1080,
        canvas_height=1920,
        full_page_fallback=False,
    )
    kwargs = {
        "tenant_id": "tenant-a",
        "project_id": "project-1",
        "production_id": "prod-1",
        "record": record,
        "source_checksum": "cd" * 32,
    }
    first = await register_l0_panel(artifacts, **kwargs)
    second = await register_l0_panel(artifacts, **kwargs)
    stored = await artifacts.get(first.artifact_id)
    assert first.reused is False
    assert second.reused is True
    assert second.artifact_id == first.artifact_id
    assert stored is not None
    assert stored.urls == ["https://cdn.example/panel.png"]
    assert stored.diagnostics["visible"] is True


def test_layer_gate_rejects_damage_and_keeps_the_threshold_boundary() -> None:
    rules = LayerGateThresholds()
    good = _package()
    before = good.model_dump()
    accepted = evaluate_layers(good, expected_canvas=CANVAS, checksums=_checksums(good))
    assert accepted.decision == "accepted"
    assert accepted.threshold_version == rules.version
    assert good.model_dump() == before

    boundary = _package(
        diagnostics=LayerDiagnostics(
            recomposition_score=rules.max_recomposition_score,
            alpha_hole_ratio=rules.max_alpha_hole_ratio,
            edge_artifact_score=rules.max_edge_artifact_score,
            requires_fallback=False,
            warnings=[],
        )
    )
    boundary_result = evaluate_layers(
        boundary,
        expected_canvas=CANVAS,
        checksums=_checksums(boundary),
    )
    assert boundary_result.accepted

    hole = _package(
        diagnostics=LayerDiagnostics(
            recomposition_score=0.1,
            alpha_hole_ratio=rules.max_alpha_hole_ratio + 0.01,
            edge_artifact_score=0.01,
            requires_fallback=False,
            warnings=[],
        )
    )
    hole_result = evaluate_layers(hole, expected_canvas=CANVAS, checksums=_checksums(hole))
    assert hole_result.reason_code == "alpha-hole"

    fringe = _package(
        diagnostics=LayerDiagnostics(
            recomposition_score=0.1,
            alpha_hole_ratio=0.01,
            edge_artifact_score=rules.max_edge_artifact_score + 0.01,
            requires_fallback=False,
            warnings=[],
        )
    )
    assert (
        evaluate_layers(fringe, expected_canvas=CANVAS, checksums=_checksums(fringe)).reason_code
        == "edge-artifact"
    )
    over = _package(
        diagnostics=LayerDiagnostics(
            recomposition_score=rules.max_recomposition_score + 0.01,
            alpha_hole_ratio=0.01,
            edge_artifact_score=0.01,
            requires_fallback=False,
            warnings=[],
        )
    )
    assert (
        evaluate_layers(over, expected_canvas=CANVAS, checksums=_checksums(over)).reason_code
        == "recomposition-failed"
    )

    shifted = _package(
        layers=[
            _layer("background", 0, bounds=LayerBounds(x=-1, y=0, width=10, height=10)),
            _layer("body", 10),
        ]
    )
    shifted_result = evaluate_layers(
        shifted,
        expected_canvas=CANVAS,
        checksums=_checksums(shifted),
    )
    assert shifted_result.reason_code == "bounds-mismatch"
    mismatched = _package(canvas=LayerCanvas(width=100, height=200))
    assert (
        evaluate_layers(
            mismatched,
            expected_canvas=CANVAS,
            checksums=_checksums(mismatched),
        ).reason_code
        == "canvas-mismatch"
    )
    occluded = _package(layers=[_layer("background", 20), _layer("body", 10)])
    occluded_result = evaluate_layers(
        occluded,
        expected_canvas=CANVAS,
        checksums=_checksums(occluded),
    )
    assert occluded_result.reason_code == "occlusion-error"
    forced = _package(
        diagnostics=LayerDiagnostics(
            recomposition_score=0.1,
            alpha_hole_ratio=0.01,
            edge_artifact_score=0.01,
            requires_fallback=True,
            warnings=[],
        )
    )
    forced_result = evaluate_layers(forced, expected_canvas=CANVAS, checksums=_checksums(forced))
    assert forced_result.decision == "fallback"
    assert forced_result.reason_code == "provider-requires-fallback"
    unreadable = evaluate_layers(good, expected_canvas=CANVAS, checksums={})
    assert unreadable.reason_code == "url-unreadable"


def test_input_hash_includes_threshold_model_and_parameter_versions() -> None:
    shared = {
        "project_id": "project-1",
        "shot_id": SHOT,
        "source_checksum": "ab" * 32,
        "canvas_width": 1080,
        "canvas_height": 1920,
        "model_version": "layer-v1",
        "parameter_version": "params-v1",
        "threshold_version": "layer-gate-v1",
    }
    original = layer_input_hash(**shared)
    assert original != layer_input_hash(**{**shared, "threshold_version": "layer-gate-v2"})
    assert original != layer_input_hash(**{**shared, "model_version": "layer-v2"})
    assert original != layer_input_hash(**{**shared, "parameter_version": "params-v2"})


async def test_l1_reuses_cache_and_does_not_pay_for_a_replay() -> None:
    provider = ScriptedLayers()
    runtime = _runtime(provider)
    _accepted_row, service = await _accepted(runtime)
    kwargs = {
        "shot_id": SHOT,
        "source_url": "https://cdn.example/panel.png",
        "source_checksum": "ab" * 32,
        "canvas_width": 1080,
        "canvas_height": 1920,
    }
    first = await service.prepare_shot(**kwargs)
    second = await service.prepare_shot(**kwargs)
    assert first.effective_level == "L1"
    assert second.effective_level == "L1"
    assert second.package is not None
    assert provider.separate_calls == 1


async def test_l1_partial_duplicate_corrupt_and_budget_stop_are_fallbacks() -> None:
    provider = ScriptedLayers()
    runtime = _runtime(provider)
    accepted, service = await _accepted(runtime)
    kwargs = {
        "shot_id": SHOT,
        "source_url": "https://cdn.example/panel.png",
        "source_checksum": "ab" * 32,
        "canvas_width": 1080,
        "canvas_height": 1920,
    }
    provider.mode = "partial"
    partial = await service.prepare_shot(**kwargs)
    assert partial.effective_level == "L0"
    assert partial.package is None
    assert partial.downgrade_reason == "partial-response"
    assert provider.separate_calls == 1
    assert (await service.prepare_shot(**kwargs)).downgrade_reason == "partial-response"
    assert provider.separate_calls == 1

    provider.mode = "duplicate"
    duplicate = await service.prepare_shot(**{**kwargs, "shot_id": f"shot:{PAGE}:1:part:0"})
    assert duplicate.downgrade_reason == "duplicate-layer-id"
    assert duplicate.package is None

    provider.mode = "corrupt"
    corrupt = await service.prepare_shot(**{**kwargs, "shot_id": f"shot:{PAGE}:2:part:0"})
    assert corrupt.downgrade_reason == "corrupt-alpha"

    async with runtime.ledger.transaction() as session:
        row = await session.get_production(accepted.production_id)
        assert row is not None
        row.actual_cost_fen = 8000
        assert await session.save_production(row, expected_version=row.version) is not None
    calls = provider.separate_calls
    stopped = await service.prepare_shot(**{**kwargs, "shot_id": f"shot:{PAGE}:3:part:0"})
    assert stopped.downgrade_reason == "enhancement-budget-stopped"
    assert provider.separate_calls == calls


async def test_l1_timeout_reconciles_without_a_second_provider_call() -> None:
    provider = ScriptedLayers()
    provider.mode = "timeout"
    provider.reconcile_ready = False
    runtime = _runtime(provider)
    _accepted_row, service = await _accepted(runtime)
    kwargs = {
        "shot_id": SHOT,
        "source_url": "https://cdn.example/panel.png",
        "source_checksum": "ab" * 32,
        "canvas_width": 1080,
        "canvas_height": 1920,
    }
    pending = await service.prepare_shot(**kwargs)
    assert pending.pending is True
    assert provider.separate_calls == 1
    provider.reconcile_ready = True
    provider.mode = "ok"
    recovered = await service.prepare_shot(**kwargs)
    assert recovered.effective_level == "L1"
    assert provider.separate_calls == 1


async def test_concurrent_prepare_does_not_pay_twice() -> None:
    provider = ScriptedLayers()
    provider.block = True
    provider.reconcile_ready = False
    runtime = _runtime(provider)
    _accepted_row, service = await _accepted(runtime)
    kwargs = {
        "shot_id": SHOT,
        "source_url": "https://cdn.example/panel.png",
        "source_checksum": "ab" * 32,
        "canvas_width": 1080,
        "canvas_height": 1920,
    }
    first = asyncio.create_task(service.prepare_shot(**kwargs))
    await provider.started.wait()
    second = asyncio.create_task(service.prepare_shot(**kwargs))
    second_result = await second
    assert second_result.pending is True
    assert provider.separate_calls == 1
    provider.release.set()
    first_result = await first
    assert first_result.effective_level == "L1"
    assert provider.separate_calls == 1


async def test_mixed_shots_keep_l0_playable_and_replay_does_not_move_revision() -> None:
    provider = ScriptedLayers()
    remotion = ScriptedRemotion()
    pages = [("https://cdn.example/page-1.png", 1), ("https://cdn.example/page-2.png", 2)]
    images = {url: page_png(f"page-{number}") for url, number in pages}
    runtime = build_stage_c(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=provider,
    )
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request(pages, request_id="stage-c"),
    )
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    provider.fail_shot_id = row.stage_facts["SYNTHESIZING_VOICE"]["shots"][1]["shot_id"]
    prepared = await runtime.assets.run(accepted.production_id)
    assert prepared.state is ProductionState.COMPOSING
    calls = provider.separate_calls
    assert calls == 2
    again = await runtime.assets.run(accepted.production_id)
    assert again.state is ProductionState.COMPOSING
    assert provider.separate_calls == calls

    stored = await runtime.productions.get_row(accepted.production_id)
    fact = stored.stage_facts["PREPARING_ASSETS"]
    levels = {shot["effectiveAnimationLevel"] for shot in fact["shots"]}
    assert levels == {"L0", "L1"}
    assert fact["level"] == "mixed"
    failed = next(shot for shot in fact["shots"] if shot["effectiveAnimationLevel"] == "L0")
    upgraded = next(shot for shot in fact["shots"] if shot["effectiveAnimationLevel"] == "L1")
    assert failed["downgradeReason"] == "provider-permanent"
    draft = await runtime.drafts.get(accepted.project_id)
    revision = draft.revision
    assert _hidden(draft.project, upgraded["shotId"]) is True
    assert _hidden(draft.project, failed["shotId"]) is False
    assert l0_asset_retained(draft.project, upgraded["shotId"])
    assert l0_asset_retained(draft.project, failed["shotId"])

    artifact = await runtime.artifacts.get(upgraded["layerArtifactId"])
    assert artifact is not None
    package = LayerPackage.model_validate(artifact.diagnostics["package"])
    command = compose_command(
        accepted.project_id,
        "layers/import",
        {"layerPackage": package.wire()},
    )
    assert command.command_id == upgraded["commandId"]
    replayed = await runtime.applier.apply(command)
    assert replayed.resulting_revision == revision
    assert remotion.apply_calls.count("layers/import") == 1
    assert remotion.apply_calls.count("image/sequence") == 1

    delivered = await runtime.render.run(accepted.production_id)
    assert delivered.state is ProductionState.DELIVERED
    assert delivered.state is not ProductionState.PERMANENT_FAILED
    final = await runtime.drafts.get(accepted.project_id)
    assert _hidden(final.project, upgraded["shotId"]) is True
    assert l0_asset_retained(final.project, upgraded["shotId"])
    assert remotion.apply_calls.count("image/sequence") == 1
    assert provider.separate_calls == calls


async def test_layers_tool_rejects_unbound_packages_and_replays_one_import() -> None:
    provider = ScriptedLayers()
    remotion = ScriptedRemotion()
    images = {"https://cdn.example/page-1.png": page_png("page-1")}
    runtime = build_stage_c(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=provider,
    )
    accepted = await runtime.service.accept("tenant-a", production_request(request_id="tool"))
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    plates = shot_plates(row.stage_facts)
    await runtime.applier.apply(
        compose_command(
            accepted.project_id,
            "image/sequence",
            l0_sequence_payload(
                [plate.shot for plate in plates],
                width=1080,
                height=1920,
            ),
        )
    )
    prepared = await runtime.layers.prepare(
        "tenant-a",
        accepted.production_id,
        plates[0].shot.shot_id,
    )
    assert prepared["effectiveLevel"] == "L1"
    assert prepared["package"]["schemaVersion"] == 1
    package = LayerPackage.model_validate(prepared["package"])
    draft = await runtime.drafts.get(accepted.project_id)
    with pytest.raises(ComicServiceError) as bad_hash:
        await runtime.layers.import_package(
            "tenant-a",
            accepted.production_id,
            shot_id=package.shot_id,
            expected_revision=draft.revision,
            input_hash="ab" * 32,
            package=package,
        )
    assert bad_hash.value.code == "INVALID_REQUEST"

    fallback = package.model_copy(
        update={
            "diagnostics": package.diagnostics.model_copy(update={"requires_fallback": True})
        }
    )
    blocked = await runtime.layers.import_package(
        "tenant-a",
        accepted.production_id,
        shot_id=fallback.shot_id,
        expected_revision=draft.revision,
        input_hash=package_input_hash(fallback),
        package=fallback,
    )
    assert blocked["effectiveLevel"] == "L0"
    assert blocked["fallbackReason"] == "provider-requires-fallback"
    assert remotion.apply_calls.count("layers/import") == 0

    imported = await runtime.layers.import_package(
        "tenant-a",
        accepted.production_id,
        shot_id=package.shot_id,
        expected_revision=draft.revision,
        input_hash=prepared["inputHash"],
        package=prepared["package"],
    )
    assert imported["effectiveLevel"] == "L1"
    assert imported["commandId"]
    replayed = await runtime.layers.import_package(
        "tenant-a",
        accepted.production_id,
        shot_id=package.shot_id,
        expected_revision=imported["revision"],
        input_hash=prepared["inputHash"],
        package=prepared["package"],
    )
    assert replayed["revision"] == imported["revision"]
    assert remotion.apply_calls.count("layers/import") == 1

    with pytest.raises(ComicServiceError) as missing:
        await runtime.layers.import_package(
            "tenant-b",
            accepted.production_id,
            shot_id=package.shot_id,
            expected_revision=imported["revision"],
            input_hash=prepared["inputHash"],
            package=prepared["package"],
        )
    assert missing.value.code == "INVALID_REQUEST"
    with pytest.raises(ComicServiceError) as unknown:
        await runtime.layers.import_package(
            "tenant-a",
            accepted.production_id,
            shot_id=package.shot_id,
            expected_revision=imported["revision"],
            input_hash=prepared["inputHash"],
            package={"semantic": "hero", "imageUrl": "file:///tmp/layer.png"},
        )
    assert unknown.value.code == "INVALID_REQUEST"


class _ConflictOnce(ScriptedRemotion):
    def __init__(self) -> None:
        super().__init__()
        self._failed = False

    async def apply(self, **kwargs: object):
        if kwargs["command_name"] == "layers/import" and not self._failed:
            self._failed = True
            self.apply_calls.append("layers/import")
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "stale revision",
                retryable=True,
            )
        return await super().apply(**kwargs)  # type: ignore[arg-type]


async def test_cas_conflict_replays_the_same_import_command() -> None:
    provider = ScriptedLayers()
    remotion = _ConflictOnce()
    images = {"https://cdn.example/page-1.png": page_png("page-1")}
    runtime = build_stage_c(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        layer_provider=provider,
    )
    accepted = await runtime.service.accept("tenant-a", production_request(request_id="cas"))
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    prepared = await runtime.assets.run(accepted.production_id)
    fact = (await runtime.productions.get_row(accepted.production_id)).stage_facts
    shot = fact["PREPARING_ASSETS"]["shots"][0]
    assert prepared.state is ProductionState.COMPOSING
    assert shot["effectiveAnimationLevel"] == "L1"
    assert remotion.apply_calls.count("layers/import") == 2
    assert provider.separate_calls == 1
    draft = await runtime.drafts.get(accepted.project_id)
    assert draft.revision == shot["revision"]


async def test_layers_import_posts_to_the_compose_route() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"type": "success", "project": empty_project()})

    client = RemotionHttpClient(
        "http://remotion.test",
        allowed_hosts=HOSTS,
        transport=httpx.MockTransport(handler),
    )
    await client.apply(
        client_request_id="compose:layers/import:1",  # type: ignore[arg-type]
        expected_revision=1,
        project=empty_project(),
        command_name="layers/import",
        payload={"layerPackage": {"sourceUrl": "https://cdn.example/source.png"}},
    )
    await client.aclose()
    assert seen == ["/api/compose/layers/import"]


def _hidden(project: dict, shot_id: str) -> bool | None:
    for track in project.get("tracks") or []:
        if track.get("id") == l0_track_id(shot_id):
            return bool(track.get("hidden"))
    return None
