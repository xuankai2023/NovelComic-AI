"""Compose the stage B control plane without starting a second application."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from .analyzer.image_fetcher import ImageFetcher
from .analyzer.panel_analyzer import PanelAnalyzer, PanelCropper, PanelDetector
from .api.product_routes import Authenticator, create_product_router
from .audio.voice_synthesizer import SpeechProvider
from .drafts.apply_compose_command import ComposeCommandApplier
from .persistence.ledger import Ledger
from .rendering.remotion_client import RenderingGateway
from .repositories.artifact_repository import ArtifactRepository
from .repositories.cost_repository import CostRepository
from .repositories.draft_repository import LedgerDraftRepository
from .repositories.production_repository import ProductionRepository
from .repositories.render_repository import RenderRepository
from .services.production_service import ProductionService
from .storage.object_store import ObjectStore
from .workers.analyze_worker import AnalyzeWorker
from .workers.render_worker import RenderWorker
from .workers.voice_worker import VoiceWorker


@dataclass
class StageBRuntime:
    ledger: Ledger
    objects: ObjectStore
    service: ProductionService
    productions: ProductionRepository
    drafts: LedgerDraftRepository
    artifacts: ArtifactRepository
    costs: CostRepository
    renders: RenderRepository
    analyze: AnalyzeWorker
    voice: VoiceWorker
    render: RenderWorker
    applier: ComposeCommandApplier
    router: APIRouter


def build_stage_b(
    *,
    ledger: Ledger,
    remotion: RenderingGateway,
    objects: ObjectStore,
    detector: PanelDetector,
    speech: SpeechProvider,
    fetcher: ImageFetcher,
    allowed_hosts: frozenset[str],
    authenticate: Authenticator,
    cropper: PanelCropper | None = None,
    provider_config_version: str = "panel-v1",
    speech_provider_name: str = "tts",
    speech_provider_version: str = "tts-v1",
    tts_worst_case_fen: int = 100,
    render_worst_case_fen: int = 100,
    phase: str = "B",
) -> StageBRuntime:
    productions = ProductionRepository(ledger)
    drafts = LedgerDraftRepository(ledger)
    artifacts = ArtifactRepository(ledger)
    costs = CostRepository(ledger)
    renders = RenderRepository(ledger)
    service = ProductionService(
        productions=productions,
        renders=renders,
        objects=objects,
        remotion=remotion,
        phase=phase,
    )
    applier = ComposeCommandApplier(drafts, remotion)
    analyze = AnalyzeWorker(
        productions=productions,
        artifacts=artifacts,
        objects=objects,
        analyzer=PanelAnalyzer(
            detector,
            provider_config_version=provider_config_version,
            cropper=cropper,
        ),
        fetcher=fetcher,
        allowed_hosts=allowed_hosts,
    )
    voice = VoiceWorker(
        productions=productions,
        artifacts=artifacts,
        costs=costs,
        objects=objects,
        provider=speech,
        provider_name=speech_provider_name,
        provider_config_version=speech_provider_version,
        worst_case_fen=tts_worst_case_fen,
    )
    render = RenderWorker(
        productions=productions,
        drafts=drafts,
        renders=renders,
        costs=costs,
        objects=objects,
        remotion=remotion,
        applier=applier,
        render_worst_case_fen=render_worst_case_fen,
        fetcher=fetcher,
    )
    return StageBRuntime(
        ledger=ledger,
        objects=objects,
        service=service,
        productions=productions,
        drafts=drafts,
        artifacts=artifacts,
        costs=costs,
        renders=renders,
        analyze=analyze,
        voice=voice,
        render=render,
        applier=applier,
        router=create_product_router(service, authenticate),
    )
