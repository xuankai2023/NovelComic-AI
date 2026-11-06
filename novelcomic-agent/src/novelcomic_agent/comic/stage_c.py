"""Stage C runtime. Stage B wiring stays free of L1 imports."""

from __future__ import annotations

from dataclasses import dataclass

from .analyzer.image_fetcher import ImageFetcher
from .analyzer.panel_analyzer import PanelCropper, PanelDetector
from .api.product_routes import Authenticator
from .assets.l1_layer_service import LayerProvider
from .assets.layer_quality_gate import LayerGateThresholds
from .audio.voice_synthesizer import SpeechProvider
from .persistence.ledger import Ledger
from .rendering.remotion_client import RenderingGateway
from .storage.object_store import ObjectStore
from .tools.layers import LayerTools
from .wiring import StageBRuntime, build_stage_b
from .workers.asset_worker import AssetWorker


@dataclass
class StageCRuntime:
    base: StageBRuntime
    assets: AssetWorker
    layers: LayerTools

    @property
    def service(self):
        return self.base.service

    @property
    def productions(self):
        return self.base.productions

    @property
    def drafts(self):
        return self.base.drafts

    @property
    def artifacts(self):
        return self.base.artifacts

    @property
    def objects(self):
        return self.base.objects

    @property
    def analyze(self):
        return self.base.analyze

    @property
    def voice(self):
        return self.base.voice

    @property
    def render(self):
        return self.base.render

    @property
    def applier(self):
        return self.base.applier

    @property
    def ledger(self):
        return self.base.ledger


def build_stage_c(
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
) -> StageCRuntime:
    base = build_stage_b(
        ledger=ledger,
        remotion=remotion,
        objects=objects,
        detector=detector,
        speech=speech,
        fetcher=fetcher,
        allowed_hosts=allowed_hosts,
        authenticate=authenticate,
        cropper=cropper,
        provider_config_version=provider_config_version,
        speech_provider_name=speech_provider_name,
        speech_provider_version=speech_provider_version,
        tts_worst_case_fen=tts_worst_case_fen,
        render_worst_case_fen=render_worst_case_fen,
    )
    rules = thresholds or LayerGateThresholds()
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
    return StageCRuntime(base=base, assets=assets, layers=layers)
