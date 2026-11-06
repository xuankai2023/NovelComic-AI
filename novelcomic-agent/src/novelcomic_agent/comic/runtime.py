"""Start stage B inside the existing FastAPI process."""

from __future__ import annotations

import asyncio
import importlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI

from novelcomic_agent.config import Settings

from .analyzer.image_fetcher import HttpxImageFetcher, ImageFetcher
from .analyzer.panel_analyzer import PageDetection, PanelCropper, PanelDetector
from .api.agent_auth import comic_authenticator
from .audio.voice_synthesizer import SpeechProvider, SpeechSynthesis
from .contracts.errors import ComicServiceError
from .persistence.migrate import apply_migrations
from .persistence.postgres import PostgresLedger
from .queue.outbox_publisher import OutboxPublisher, WorkerQueue
from .queue.rabbit_broker import RabbitWorkerBroker
from .queue.worker_consumer import WorkerConsumer
from .rendering.remotion_client import RemotionHttpClient, RenderingGateway
from .stage_c import build_stage_c
from .stage_d import build_stage_d
from .storage.object_store import ObjectStore
from .wiring import StageBRuntime, build_stage_b

logger = logging.getLogger(__name__)

RabbitConnect = Callable[[], Awaitable[Any]]
_UNSET = object()


class UnconfiguredPanelDetector:
    """Placeholder until the OpenCV detector is installed."""

    async def detect(
        self,
        *,
        page_id: str,
        image: bytes,
        reading_direction: str,
    ) -> PageDetection:
        del page_id, image, reading_direction
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "panel detector is not configured",
            retryable=False,
        )


class UnconfiguredSpeechProvider:
    """Placeholder until the speech provider module is installed."""

    async def synthesize(
        self,
        *,
        request_id: str,
        text: str,
        voice_id: str,
    ) -> SpeechSynthesis:
        del request_id, text, voice_id
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "speech provider is not configured",
            retryable=False,
        )

    async def reconcile(self, request_id: str) -> SpeechSynthesis | None:
        del request_id
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "speech provider is not configured",
            retryable=False,
        )


def allowed_image_hosts(settings: Settings) -> frozenset[str]:
    """Hosts admitted for source pages and for the COS CDN address stored in the ledger."""

    hosts = {
        item.strip().lower() for item in settings.comic_allowed_hosts.split(",") if item.strip()
    }
    domain = settings.cos_cdn_domain.strip()
    if domain:
        parsed = urlsplit(domain if "://" in domain else f"https://{domain}")
        if parsed.hostname:
            hosts.add(parsed.hostname.lower())
    return frozenset(hosts)


def load_panel_detector(settings: Settings) -> PanelDetector:
    """Return the OpenCV detector, or a placeholder when that module is absent."""

    detector = _load_adapter(
        "novelcomic_agent.comic.providers.opencv_panel",
        "OpenCvPanelDetector",
        settings,
    )
    if detector is None:
        return UnconfiguredPanelDetector()
    return detector


def load_speech_provider(settings: Settings) -> SpeechProvider:
    """Return the HTTP speech provider. A missing module stays unconfigured.

    When the provider module is installed, ``from_settings`` fails startup if the
    TTS key or endpoint is missing.
    """

    speech = _load_adapter(
        "novelcomic_agent.comic.providers.speech",
        "HttpSpeechProvider",
        settings,
    )
    if speech is None:
        return UnconfiguredSpeechProvider()
    return speech


def load_stage_b_adapters(
    settings: Settings,
) -> tuple[PanelDetector, PanelCropper | None, SpeechProvider]:
    """Use the real adapters when they are installed, otherwise start without them."""

    return (
        load_panel_detector(settings),
        _load_pixel_cropper(),
        load_speech_provider(settings),
    )


@dataclass
class StageBProcess:
    runtime: StageBRuntime
    publisher: OutboxPublisher
    consumer: WorkerConsumer
    tasks: list[asyncio.Task[None]] = field(default_factory=list)
    _stop: asyncio.Event = field(default_factory=asyncio.Event)
    _owned: list[Any] = field(default_factory=list)

    async def aclose(self) -> None:
        self._stop.set()
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=2)
            pending = [task for task in self.tasks if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            self.tasks.clear()
        for resource in reversed(self._owned):
            await _aclose(resource)
        self._owned.clear()


async def start_stage_b_process(
    app: FastAPI,
    *,
    settings: Settings,
    pool: Any,
    connect_rabbit: RabbitConnect | None = None,
    objects: ObjectStore | None = None,
    remotion: RenderingGateway | None = None,
    detector: PanelDetector | None = None,
    speech: SpeechProvider | None = None,
    cropper: Any = _UNSET,
    fetcher: ImageFetcher | None = None,
    broker: WorkerQueue | None = None,
    poll_seconds: float = 0.5,
) -> StageBProcess:
    """Migrate, mount the product routes, and run the outbox publisher and workers."""

    owned: list[Any] = []
    try:
        await apply_migrations(pool)
        hosts = allowed_image_hosts(settings)
        if objects is None:
            from .storage.cos_store import CosObjectStore

            objects = CosObjectStore.from_settings(settings)
            owned.append(objects)
        if remotion is None:
            remotion = RemotionHttpClient(
                settings.remotion_compose_base_url,
                allowed_hosts=hosts,
            )
            owned.append(remotion)
        if fetcher is None:
            fetcher = HttpxImageFetcher(hosts)
            owned.append(fetcher)
        if detector is None:
            detector = load_panel_detector(settings)
            owned.append(detector)
        if speech is None:
            speech = load_speech_provider(settings)
            owned.append(speech)
        if cropper is _UNSET:
            cropper = _load_pixel_cropper()
        ledger = PostgresLedger(pool)
        authenticate = comic_authenticator(settings)
        layer_provider = load_layer_provider(settings, fetcher)
        sprite_provider = load_sprite_provider(settings)
        assets_run = None
        if layer_provider is not None and sprite_provider is not None:
            owned.append(layer_provider)
            owned.append(sprite_provider)
            stage_d = build_stage_d(
                ledger=ledger,
                remotion=remotion,
                objects=objects,
                detector=detector,
                speech=speech,
                fetcher=fetcher,
                allowed_hosts=hosts,
                authenticate=authenticate,
                layer_provider=layer_provider,
                sprite_provider=sprite_provider,
                cropper=cropper,
                layer_worst_case_fen=settings.comic_layer_unit_price_fen,
                sprite_worst_case_fen=settings.comic_sprite_unit_price_fen,
                l2_enabled=True,
            )
            runtime = stage_d.base
            assets_run = stage_d.assets.run
            logger.info("comic L2 sprite worker owns PREPARING_ASSETS")
        elif layer_provider is not None:
            owned.append(layer_provider)
            stage_c = build_stage_c(
                ledger=ledger,
                remotion=remotion,
                objects=objects,
                detector=detector,
                speech=speech,
                fetcher=fetcher,
                allowed_hosts=hosts,
                authenticate=authenticate,
                layer_provider=layer_provider,
                cropper=cropper,
                layer_worst_case_fen=settings.comic_layer_unit_price_fen,
            )
            runtime = stage_c.base
            assets_run = stage_c.assets.run
            logger.info("comic L1 asset worker owns PREPARING_ASSETS")
        else:
            runtime = build_stage_b(
                ledger=ledger,
                remotion=remotion,
                objects=objects,
                detector=detector,
                speech=speech,
                fetcher=fetcher,
                allowed_hosts=hosts,
                authenticate=authenticate,
                cropper=cropper,
            )
        if not getattr(app.state, "comic_routes", False):
            app.include_router(runtime.router)
            app.state.comic_routes = True
        publisher = OutboxPublisher(
            ledger,
            broker,
            owner=f"publisher-{uuid4().hex}",
        )
        consumer = WorkerConsumer(
            analyze=runtime.analyze.run,
            voice=runtime.voice.run,
            render=runtime.render.run,
            productions=runtime.productions,
            assets=assets_run,
        )
        process = StageBProcess(
            runtime=runtime,
            publisher=publisher,
            consumer=consumer,
            _owned=owned,
        )
        stop = process._stop
        if broker is not None:
            process.tasks = [
                asyncio.create_task(
                    _poll_publisher(publisher, stop, poll_seconds),
                    name="comic-outbox-publisher",
                ),
                asyncio.create_task(
                    _consume_until_stop(consumer, broker, stop),
                    name="comic-worker-consumer",
                ),
            ]
        else:
            if connect_rabbit is None:
                raise RuntimeError("stage B needs a RabbitMQ connection")
            process.tasks = [
                asyncio.create_task(
                    _publish_with_rabbit(publisher, connect_rabbit, stop, poll_seconds),
                    name="comic-outbox-publisher",
                ),
                asyncio.create_task(
                    _consume_with_rabbit(consumer, connect_rabbit, stop),
                    name="comic-worker-consumer",
                ),
            ]
        return process
    except Exception:
        for resource in reversed(owned):
            await _aclose(resource)
        raise


def load_layer_provider(settings: Settings, fetcher: ImageFetcher) -> Any | None:
    """Return the L1 separator. Prefer Aliyun HD when VIAPI keys are set."""

    if (
        settings.aliyun_viapi_access_key_id.strip()
        and settings.aliyun_viapi_access_key_secret.strip()
    ):
        try:
            from .providers.aliyun_layer import AliyunLayerProvider
        except ImportError as exc:
            logger.warning("Aliyun L1 layer provider is unavailable: %s", exc)
        else:
            provider = AliyunLayerProvider.from_settings(settings, fetcher)
            if provider is not None:
                logger.info("L1 layer provider: Aliyun SegmentHDCommonImage")
                return provider

    try:
        from .providers.gpt_image_layer import GptImageLayerProvider
    except ImportError as exc:
        logger.warning("L1 layer provider is unavailable: %s", exc)
        return None
    logger.info("L1 layer provider: GPT Image / OpenCV fallback")
    return GptImageLayerProvider.from_settings(settings, fetcher)


def load_sprite_provider(settings: Settings) -> Any | None:
    """Return the L2 sprite provider when OpenCreator GPT Image keys are present."""

    try:
        from .providers.gpt_image_sprite import GptImageSpriteProvider
    except ImportError as exc:
        logger.warning("L2 sprite provider is unavailable: %s", exc)
        return None
    return GptImageSpriteProvider.from_settings(settings)


def _load_adapter(module_name: str, class_name: str, settings: Settings) -> Any | None:
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            return None
        raise
    cls = getattr(module, class_name, None)
    if cls is None:
        return None
    factory = getattr(cls, "from_settings", None)
    if callable(factory):
        return factory(settings)
    try:
        return cls()
    except TypeError:
        return cls(settings)


def _load_pixel_cropper() -> PanelCropper | None:
    module_name = "novelcomic_agent.comic.analyzer.pixel_cropper"
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            return None
        raise
    for name in ("PixelCropper", "PixelPanelCropper"):
        cls = getattr(module, name, None)
        if isinstance(cls, type):
            return cls()
    raise RuntimeError("pixel cropper module does not define PixelCropper")


async def _poll_publisher(
    publisher: OutboxPublisher,
    stop: asyncio.Event,
    poll_seconds: float,
) -> None:
    while not stop.is_set():
        try:
            await publisher.publish_available()
        except Exception:
            logger.exception("comic outbox publish failed")
        if await _wait(stop, poll_seconds):
            return


async def _publish_with_rabbit(
    publisher: OutboxPublisher,
    connect_rabbit: RabbitConnect,
    stop: asyncio.Event,
    poll_seconds: float,
) -> None:
    while not stop.is_set():
        broker: RabbitWorkerBroker | None = None
        try:
            broker = await RabbitWorkerBroker.connect(await connect_rabbit())
            publisher.bind_queue(broker)
            while not stop.is_set():
                await publisher.publish_available()
                if await _wait(stop, poll_seconds):
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("comic outbox publisher disconnected")
        finally:
            publisher.bind_queue(None)
            if broker is not None:
                await _aclose(broker)
        if stop.is_set() or await _wait(stop, 1):
            return


async def _consume_until_stop(
    consumer: WorkerConsumer,
    broker: WorkerQueue,
    stop: asyncio.Event,
) -> None:
    await broker.consume(consumer.handle)
    await stop.wait()


async def _consume_with_rabbit(
    consumer: WorkerConsumer,
    connect_rabbit: RabbitConnect,
    stop: asyncio.Event,
) -> None:
    while not stop.is_set():
        broker: RabbitWorkerBroker | None = None
        try:
            broker = await RabbitWorkerBroker.connect(await connect_rabbit())
            await broker.consume(consumer.handle)
            await stop.wait()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("comic worker consumer disconnected")
        finally:
            if broker is not None:
                await _aclose(broker)
        if stop.is_set() or await _wait(stop, 1):
            return


async def _wait(stop: asyncio.Event, seconds: float) -> bool:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except TimeoutError:
        return False
    return True


async def _aclose(resource: Any) -> None:
    closer = getattr(resource, "aclose", None)
    if closer is None:
        closer = getattr(resource, "close", None)
    if closer is None:
        return
    try:
        result = closer()
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        logger.exception("comic resource close failed")
