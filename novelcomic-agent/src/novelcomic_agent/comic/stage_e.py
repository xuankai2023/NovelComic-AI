"""Stage E runtime. It keeps the stage B path and adds preview, review, and packaging."""

from __future__ import annotations

from dataclasses import dataclass

from .analyzer.image_fetcher import ImageFetcher
from .analyzer.panel_analyzer import PanelDetector
from .api.product_routes import Authenticator
from .audio.voice_synthesizer import SpeechProvider
from .operations.alerting import AlertChannel, AlertService
from .operations.retention_policy import RetentionService
from .operations.tenant_policy import TenantDirectory
from .persistence.ledger import Ledger
from .qa.fix_policy import FixPolicy
from .qa.reviewer import Reviewer, ReviewProvider
from .rendering.remotion_client import RenderingGateway
from .repositories.delivery_repository import DeliveryRepository
from .storage.object_store import ObjectStore
from .tools.delivery import DeliveryTools
from .tools.review import ReviewTools
from .wiring import StageBRuntime, build_stage_b
from .workers.package_worker import PackageWorker
from .workers.preview_worker import PreviewWorker


@dataclass
class StageERuntime:
    base: StageBRuntime
    preview: PreviewWorker
    package: PackageWorker
    reviews: ReviewTools
    deliveries_api: DeliveryTools
    alerts: AlertService
    retention: RetentionService
    directory: TenantDirectory

    def __getattr__(self, name: str) -> object:
        return getattr(self.base, name)


def build_stage_e(
    *,
    ledger: Ledger,
    remotion: RenderingGateway,
    objects: ObjectStore,
    detector: PanelDetector,
    speech: SpeechProvider,
    fetcher: ImageFetcher,
    allowed_hosts: frozenset[str],
    authenticate: Authenticator,
    directory: TenantDirectory,
    alert_channel: AlertChannel,
    review_provider: ReviewProvider | None = None,
    provider_config_version: str = "panel-v1",
    speech_provider_name: str = "tts",
    speech_provider_version: str = "tts-v1",
    tts_worst_case_fen: int = 100,
    render_worst_case_fen: int = 100,
) -> StageERuntime:
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
        phase="E",
    )
    reviewer = Reviewer(review_provider)
    fix_policy = FixPolicy()
    alerts = AlertService(ledger, alert_channel)
    deliveries = DeliveryRepository(ledger)
    preview = PreviewWorker(
        productions=base.productions,
        drafts=base.drafts,
        artifacts=base.artifacts,
        objects=objects,
        remotion=remotion,
        applier=base.applier,
        reviewer=reviewer,
        fix_policy=fix_policy,
        directory=directory,
        fetcher=fetcher,
    )
    package = PackageWorker(
        productions=base.productions,
        drafts=base.drafts,
        artifacts=base.artifacts,
        renders=base.renders,
        deliveries=deliveries,
        objects=objects,
        directory=directory,
        alerts=alerts,
    )
    return StageERuntime(
        base=base,
        preview=preview,
        package=package,
        reviews=ReviewTools(
            productions=base.productions,
            drafts=base.drafts,
            remotion=remotion,
            reviewer=reviewer,
            preview=preview,
            directory=directory,
        ),
        deliveries_api=DeliveryTools(
            productions=base.productions,
            drafts=base.drafts,
            deliveries=deliveries,
            objects=objects,
            directory=directory,
        ),
        alerts=alerts,
        retention=RetentionService(ledger, objects),
        directory=directory,
    )
