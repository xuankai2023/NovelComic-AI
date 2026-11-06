"""Stage D runtime. The L2 flag defaults off everywhere this module is not used."""

from __future__ import annotations

from dataclasses import dataclass

from .analyzer.image_fetcher import ImageFetcher
from .analyzer.panel_analyzer import PanelCropper, PanelDetector
from .api.product_routes import Authenticator
from .assets.l1_layer_service import LayerProvider
from .assets.l2_sprite_service import SpriteProvider
from .assets.layer_quality_gate import LayerGateThresholds
from .assets.sprite_quality_gate import SpriteGateThresholds
from .audio.voice_synthesizer import SpeechProvider
from .persistence.ledger import Ledger
from .rendering.remotion_client import RenderingGateway
from .stage_c import StageCRuntime
from .storage.object_store import ObjectStore
from .tools.layers import LayerTools
from .tools.motion import MotionTools
from .wiring import build_stage_b
from .workers.asset_worker import AssetWorker


@dataclass
class StageDRuntime:
    stage: StageCRuntime
    motions: MotionTools

    def __getattr__(self, name: str) -> object:
        return getattr(self.stage, name)


def build_stage_d(
    *,
    ledger: Ledger,
    remotion: RenderingGateway,
    objects: ObjectStore,
    detector: PanelDetector,
    speech: SpeechProvider,
    fetcher: ImageFetcher,
    allowed_hosts: frozenset[str],
    authenticate: Authenticator,
    layer_provider: LayerProvider,
    sprite_provider: SpriteProvider,
    cropper: PanelCropper | None = None,
    provider_config_version: str = "panel-v1",
    speech_provider_name: str = "tts",
    speech_provider_version: str = "tts-v1",
    tts_worst_case_fen: int = 100,
    render_worst_case_fen: int = 100,
    layer_provider_name: str = "layer-l1",
    model_version: str = "layer-v1",
    parameter_version: str = "params-v1",
    layer_worst_case_fen: int = 100,
    thresholds: LayerGateThresholds | None = None,
    l2_enabled: bool = True,
    l2_tenants: frozenset[str] | None = None,
    sprite_provider_name: str = "sprite-l2",
    sprite_model_version: str = "sprite-v1",
    sprite_parameter_version: str = "sprite-params-v1",
    sprite_worst_case_fen: int = 100,
    sprite_thresholds: SpriteGateThresholds | None = None,
) -> StageDRuntime:
    base = build_stage_b(
        ledger=ledger,
        remotion=remotion,
        objects=objects,
        detector=detector,
        speech=speech,
        fetcher=fetcher,
        allowed_hosts=allowed_hosts,
        authenticate=authenticate,
        provider_config_version=provider_config_version,
        speech_provider_name=speech_provider_name,
        speech_provider_version=speech_provider_version,
        tts_worst_case_fen=tts_worst_case_fen,
        render_worst_case_fen=render_worst_case_fen,
        cropper=cropper,
    )
    rules = thresholds or LayerGateThresholds()
    sprite_rules = sprite_thresholds or SpriteGateThresholds()
    assets = AssetWorker(
        productions=base.productions,
        artifacts=base.artifacts,
        costs=base.costs,
        objects=objects,
        drafts=base.drafts,
        applier=base.applier,
        provider=layer_provider,
        allowed_hosts=allowed_hosts,
        provider_name=layer_provider_name,
        model_version=model_version,
        parameter_version=parameter_version,
        worst_case_fen=layer_worst_case_fen,
        thresholds=rules,
        sprite_provider=sprite_provider,
        l2_enabled=l2_enabled,
        l2_tenants=l2_tenants,
        sprite_provider_name=sprite_provider_name,
        sprite_model_version=sprite_model_version,
        sprite_parameter_version=sprite_parameter_version,
        sprite_worst_case_fen=sprite_worst_case_fen,
        sprite_thresholds=sprite_rules,
    )
    layers = LayerTools(
        productions=base.productions,
        artifacts=base.artifacts,
        costs=base.costs,
        objects=objects,
        drafts=base.drafts,
        applier=base.applier,
        provider=layer_provider,
        allowed_hosts=allowed_hosts,
        provider_name=layer_provider_name,
        model_version=model_version,
        parameter_version=parameter_version,
        worst_case_fen=layer_worst_case_fen,
        thresholds=rules,
    )
    motions = MotionTools(
        productions=base.productions,
        drafts=base.drafts,
        applier=base.applier,
        artifacts=base.artifacts,
    )
    return StageDRuntime(
        stage=StageCRuntime(base=base, assets=assets, layers=layers),
        motions=motions,
    )
