"""OpenCV panels, pixel crops, and OCR assignment."""

from __future__ import annotations

import base64
from io import BytesIO

import cv2
import httpx
import numpy as np
import pytest
from PIL import Image

from novelcomic_agent.comic.analyzer.image_size import (
    ImageDimensionError,
    canvas_for_image,
    measure_image,
)
from novelcomic_agent.comic.analyzer.panel_analyzer import (
    DetectedPanel,
    PageDetection,
    PanelAnalyzer,
)
from novelcomic_agent.comic.analyzer.pixel_cropper import PixelCropper
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.providers.ocr import HttpOcrEngine, OcrBubble
from novelcomic_agent.comic.providers.opencv_panel import OpenCvPanelDetector
from novelcomic_agent.comic.runtime import load_stage_b_adapters
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.wiring import build_stage_b
from novelcomic_agent.comic.workflow.production_states import ProductionState
from novelcomic_agent.config import Settings
from tests.comic_support import (
    MemoryFetcher,
    ScriptedRemotion,
    ScriptedSpeech,
    production_request,
    tenant_from_header,
)

_WIDTH = 960
_HEIGHT = 1440
_MARGIN = 36
_GUTTER = 32
_BORDER = 8
_COLORS_BGR = ((0, 0, 255), (0, 255, 0), (255, 0, 0), (0, 255, 255))
_COLORS_RGB = ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))
_HOSTS = frozenset({"cdn.example", "objects.novelcomic.local"})


def _rects() -> list[tuple[int, int, int, int]]:
    panel_width = (_WIDTH - 2 * _MARGIN - _GUTTER) // 2
    panel_height = (_HEIGHT - 2 * _MARGIN - _GUTTER) // 2
    rects: list[tuple[int, int, int, int]] = []
    for row in range(2):
        for column in range(2):
            x = _MARGIN + column * (panel_width + _GUTTER)
            y = _MARGIN + row * (panel_height + _GUTTER)
            rects.append((x, y, panel_width, panel_height))
    return rects


def _page(*, split_first: bool = False) -> bytes:
    image = np.full((_HEIGHT, _WIDTH, 3), 255, np.uint8)
    for (x, y, width, height), color in zip(_rects(), _COLORS_BGR, strict=True):
        cv2.rectangle(image, (x, y), (x + width - 1, y + height - 1), (0, 0, 0), _BORDER)
        inset = _BORDER
        cv2.rectangle(
            image,
            (x + inset, y + inset),
            (x + width - 1 - inset, y + height - 1 - inset),
            color,
            -1,
        )
    if split_first:
        x, y, width, height = _rects()[0]
        split_x = x + int(width * 0.3)
        cv2.line(image, (split_x, y), (split_x, y + height - 1), (0, 0, 0), 3)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def _blank() -> bytes:
    image = np.full((_HEIGHT, _WIDTH, 3), 255, np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes()


def _center(png: bytes) -> tuple[int, int, int]:
    with Image.open(BytesIO(png)) as image:
        image.load()
        pixel = image.getpixel((image.width // 2, image.height // 2))
        assert isinstance(pixel, tuple)
        return pixel[:3]


class _StorePublisher:
    def __init__(self, store: MemoryObjectStore) -> None:
        self.store = store

    async def publish(self, *, page_id: str, panel_index: int, body: bytes) -> str:
        key = f"artifacts/panels/{page_id[:12]}-{panel_index}.png"
        await self.store.put_verified(key, body, content_type="image/png")
        return self.store.stable_url(key)


class _PageOcr:
    def __init__(self, bubble: OcrBubble) -> None:
        self.bubble = bubble
        self.calls = 0
        self.images: list[bytes] = []

    async def recognize(self, image: bytes) -> tuple[OcrBubble, ...]:
        self.calls += 1
        self.images.append(image)
        return (self.bubble,)


def _runtime(images: dict[str, bytes]):
    return build_stage_b(
        ledger=MemoryLedger(),
        remotion=ScriptedRemotion(),
        objects=MemoryObjectStore(),
        detector=OpenCvPanelDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=_HOSTS,
        authenticate=tenant_from_header,
        cropper=PixelCropper(),
    )


async def test_grid_page_orders_panels_and_stores_real_png_crops() -> None:
    url = "https://cdn.example/grid.png"
    runtime = _runtime({url: _page()})
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request([(url, 1)], request_id="grid"),
    )
    snapshot = await runtime.analyze.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    panels = row.stage_facts["ANALYZING"]["panels"]

    assert snapshot.state is ProductionState.SYNTHESIZING_VOICE
    assert row.state != ProductionState.PERMANENT_FAILED.value
    assert len(panels) == 4
    assert [panel["bounds"]["x"] for panel in panels[:2]] == sorted(
        panel["bounds"]["x"] for panel in panels[:2]
    )
    assert panels[0]["bounds"]["y"] < panels[2]["bounds"]["y"]
    assert panels[2]["bounds"]["x"] < panels[3]["bounds"]["x"]
    assert row.stage_facts["ANALYZING"]["pageWidth"] == _WIDTH
    assert row.stage_facts["ANALYZING"]["pageHeight"] == _HEIGHT
    assert row.stage_facts["ANALYZING"]["canvasWidth"] == 1080
    assert row.stage_facts["ANALYZING"]["canvasHeight"] == 1920
    for panel, color in zip(panels, _COLORS_RGB, strict=True):
        stored = panel["panel_url"]
        assert stored.startswith("https://objects.novelcomic.local/")
        body = await runtime.objects.get(stored.removeprefix("https://objects.novelcomic.local/"))
        assert body.startswith(b"\x89PNG")
        with Image.open(BytesIO(body)) as image:
            image.load()
            assert image.size != (_WIDTH, _HEIGHT)
            assert abs(image.size[0] - panel["bounds"]["width"]) <= 1
            assert abs(image.size[1] - panel["bounds"]["height"]) <= 1
        assert _center(body) == color
        assert panel["dialogues"] == []


async def _analyze(direction: str):
    analyzer = PanelAnalyzer(
        OpenCvPanelDetector(),
        provider_config_version="panel-v1",
        cropper=PixelCropper(),
    )
    return await analyzer.analyze_page(
        image=_page(),
        source_url="https://cdn.example/grid.png",
        reading_direction=direction,
        publisher=_StorePublisher(MemoryObjectStore()),
    )


async def test_rtl_order_flips_each_row() -> None:
    ltr = await _analyze("ltr")
    rtl = await _analyze("rtl")
    assert ltr.gate.accepted is True
    assert rtl.gate.accepted is True
    assert rtl.panels[0].bounds.x > rtl.panels[1].bounds.x
    assert rtl.panels[2].bounds.x > rtl.panels[3].bounds.x
    assert rtl.panels[0].bounds.y < rtl.panels[2].bounds.y
    assert [(panel.bounds.x, panel.bounds.y) for panel in ltr.panels] == [
        (rtl.panels[1].bounds.x, rtl.panels[1].bounds.y),
        (rtl.panels[0].bounds.x, rtl.panels[0].bounds.y),
        (rtl.panels[3].bounds.x, rtl.panels[3].bounds.y),
        (rtl.panels[2].bounds.x, rtl.panels[2].bounds.y),
    ]


async def test_bubble_split_is_merged_back_into_one_panel() -> None:
    detection = await OpenCvPanelDetector().detect(
        page_id="page",
        image=_page(split_first=True),
        reading_direction="ltr",
    )
    assert len(detection.panels) == 4
    assert abs(detection.panels[0].width - detection.panels[1].width) < 20
    assert detection.raw["algorithm"] == "opencv-panel-v1"
    assert "id" not in detection.raw
    assert "providerId" not in detection.raw
    assert "provider_id" not in detection.raw
    assert all(panel.provider_id is None for panel in detection.panels)
    again = await OpenCvPanelDetector().detect(
        page_id="page",
        image=_page(split_first=True),
        reading_direction="ltr",
    )
    assert again == detection


async def test_blank_page_keeps_the_source_url_and_stays_playable() -> None:
    url = "https://cdn.example/blank.png"
    runtime = _runtime({url: _blank()})
    accepted = await runtime.service.accept(
        "tenant-a",
        production_request([(url, 1)], request_id="blank"),
    )
    snapshot = await runtime.analyze.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    panels = row.stage_facts["ANALYZING"]["panels"]

    assert snapshot.state is ProductionState.SYNTHESIZING_VOICE
    assert row.state != ProductionState.PERMANENT_FAILED.value
    assert row.degraded is True
    assert len(panels) == 1
    assert panels[0]["panel_url"] == url
    assert panels[0]["source_url"] == url
    assert "no-panels" in panels[0]["diagnostics"]["warnings"]


async def test_ocr_text_is_kept_and_low_confidence_stays_on_the_panel() -> None:
    bubble = OcrBubble(
        text="  别改原文  ",
        confidence=0.15,
        polygon=((120.0, 160.0), (220.0, 160.0), (220.0, 220.0), (120.0, 220.0)),
    )
    ocr = _PageOcr(bubble)
    detector = OpenCvPanelDetector(ocr)
    image = _page()
    detection = await detector.detect(page_id="page", image=image, reading_direction="ltr")
    found = [item for panel in detection.panels for item in panel.bubbles]
    assert ocr.calls == 1
    assert ocr.images == [image]
    assert [(item.text, item.confidence, item.speaker_key) for item in found] == [
        ("  别改原文  ", 0.15, None)
    ]

    page = await PanelAnalyzer(
        detector,
        provider_config_version="panel-v1",
        cropper=PixelCropper(),
    ).analyze_page(
        image=image,
        source_url="https://cdn.example/grid.png",
        reading_direction="ltr",
        publisher=_StorePublisher(MemoryObjectStore()),
    )
    lines = [line for panel in page.panels for line in panel.dialogues]
    assert [line.text for line in lines] == ["别改原文"]
    assert lines[0].ocr_confidence == 0.15
    assert lines[0].speaker_id is None
    assert page.gate.accepted is True
    assert page.gate.requires_manual_review is True
    assert "low-ocr-confidence" in page.gate.warnings


async def test_http_ocr_posts_the_page_and_returns_the_provider_text() -> None:
    image = _page()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "bubbles": [
                    {
                        "text": "  别改原文  ",
                        "confidence": 0.91,
                        "polygon": [[120, 160], [220, 160], [220, 220], [120, 220]],
                    }
                ]
            },
        )

    engine = HttpOcrEngine(
        endpoint="https://ocr.example/v1/recognize",
        api_key="ocr-key",
        transport=httpx.MockTransport(handler),
    )
    detector = OpenCvPanelDetector(engine)
    try:
        detection = await detector.detect(page_id="page", image=image, reading_direction="ltr")
    finally:
        await detector.aclose()
    found = [item for panel in detection.panels for item in panel.bubbles]
    assert found[0].text == "  别改原文  "
    assert seen[0].headers["authorization"] == "Bearer ocr-key"
    body = seen[0].read()
    assert base64.b64decode(httpx.Response(200, content=body).json()["imageBase64"]) == image


async def test_ocr_outage_is_retryable() -> None:
    engine = HttpOcrEngine(
        endpoint="https://ocr.example/v1/recognize",
        api_key="ocr-key",
        transport=httpx.MockTransport(lambda _request: httpx.Response(503, text="busy")),
    )
    try:
        with pytest.raises(ComicServiceError) as caught:
            await engine.recognize(b"page")
    finally:
        await engine.aclose()
    assert caught.value.code == "COMPOSE_FAILED"
    assert caught.value.body.retryable is True


async def test_missing_ocr_settings_leave_bubbles_empty(caplog: pytest.LogCaptureFixture) -> None:
    detector = OpenCvPanelDetector.from_settings(
        Settings(comic_ocr_endpoint="https://ocr.example/v1/recognize", comic_ocr_api_key="")
    )
    detection = await detector.detect(
        page_id="page",
        image=_page(),
        reading_direction="ltr",
    )
    assert detection.panels
    assert all(panel.bubbles == () for panel in detection.panels)
    assert "COMIC_OCR_API_KEY" in caplog.text


def test_pixel_cropper_cuts_png_from_pixels_or_normalized_bounds() -> None:
    canvas = Image.new("RGB", (100, 80), "white")
    canvas.paste(Image.new("RGB", (30, 20), "red"), (10, 15))
    raw = BytesIO()
    canvas.save(raw, format="PNG")
    cropper = PixelCropper()
    cropped = cropper.crop(raw.getvalue(), x=10, y=15, width=30, height=20)
    assert cropped.startswith(b"\x89PNG")
    assert not cropped.startswith(b"10.0000")
    with Image.open(BytesIO(cropped)) as image:
        assert image.size == (30, 20)
        assert image.getpixel((1, 1)) == (255, 0, 0)
    normalized = cropper.crop(raw.getvalue(), x=0.1, y=15 / 80, width=0.3, height=20 / 80)
    with Image.open(BytesIO(normalized)) as image:
        assert image.size == (30, 20)
        assert image.getpixel((1, 1)) == (255, 0, 0)
    with pytest.raises(ValueError, match="empty"):
        cropper.crop(raw.getvalue(), x=0, y=0, width=0, height=10)


def test_canvas_follows_the_measured_orientation() -> None:
    wide = Image.new("RGB", (1536, 1024), "white")
    tall = Image.new("RGB", (1024, 1536), "white")
    wide_bytes = BytesIO()
    tall_bytes = BytesIO()
    wide.save(wide_bytes, format="PNG")
    tall.save(tall_bytes, format="PNG")
    wide_size = measure_image(wide_bytes.getvalue())
    tall_size = measure_image(tall_bytes.getvalue())
    assert (wide_size.width, wide_size.height) == (1536, 1024)
    assert canvas_for_image(wide_size) == (1920, 1080)
    assert canvas_for_image(tall_size) == (1080, 1920)


async def test_crop_waits_until_the_measured_size_matches() -> None:
    class _WrongSize:
        async def detect(
            self,
            *,
            page_id: str,
            image: bytes,
            reading_direction: str,
        ) -> PageDetection:
            del page_id, image, reading_direction
            return PageDetection(
                page_width=100,
                page_height=100,
                panels=(
                    DetectedPanel(x=0, y=0, width=100, height=100, confidence=1),
                ),
                raw={},
            )

    class _Cropper:
        def __init__(self) -> None:
            self.calls = 0

        def crop(self, image: bytes, *, x: float, y: float, width: float, height: float) -> bytes:
            del image, x, y, width, height
            self.calls += 1
            return b"cropped"

    raw = BytesIO()
    Image.new("RGB", (1536, 1024), "white").save(raw, format="PNG")
    cropper = _Cropper()
    analyzer = PanelAnalyzer(_WrongSize(), provider_config_version="test", cropper=cropper)

    class _Publisher:
        async def publish(self, *, page_id: str, panel_index: int, body: bytes) -> str:
            del page_id, panel_index, body
            return "https://cdn.example/crop.png"

    with pytest.raises(ImageDimensionError, match="1536x1024"):
        await analyzer.analyze_page(
            image=raw.getvalue(),
            source_url="https://cdn.example/page.png",
            reading_direction="ltr",
            publisher=_Publisher(),
        )
    assert cropper.calls == 0


async def test_stage_b_loads_the_opencv_detector_and_pixel_cropper() -> None:
    detector, cropper, speech = load_stage_b_adapters(
        Settings(
            comic_tts_api_key="tts-key",
            comic_tts_endpoint="https://tts.example/v1/speech",
            comic_tts_voice_id="voice-default",
            comic_tts_unit_price_fen=12,
        )
    )
    try:
        assert isinstance(detector, OpenCvPanelDetector)
        assert isinstance(cropper, PixelCropper)
        assert speech.__class__.__name__ == "HttpSpeechProvider"
    finally:
        await detector.aclose()
        await speech.aclose()
