"""Panel order, stable line keys, and provider-id independence."""

from __future__ import annotations

from dataclasses import replace

from novelcomic_agent.comic.analyzer.panel_analyzer import (
    DetectedBubble,
    DetectedPanel,
    PageDetection,
    PanelAnalyzer,
)

PAGE = b"comic-page"
POLYGON_A = ((10.0, 10.0), (40.0, 10.0), (40.0, 30.0), (10.0, 30.0))
POLYGON_B = ((60.0, 12.0), (90.0, 12.0), (90.0, 32.0), (60.0, 32.0))


class RecordingPublisher:
    async def publish(self, *, page_id: str, panel_index: int, body: bytes) -> str:
        del body
        return f"https://cdn.example/crops/{page_id[:8]}-{panel_index}.png"


class FixedDetector:
    def __init__(self, panels: tuple[DetectedPanel, ...]) -> None:
        self.panels = panels
        self.calls = 0

    async def detect(self, *, page_id: str, image: bytes, reading_direction: str) -> PageDetection:
        del page_id, image, reading_direction
        self.calls += 1
        noisy = tuple(
            replace(panel, provider_id=f"noise-{self.calls}-{index}")
            for index, panel in enumerate(reversed(self.panels))
        )
        return PageDetection(
            page_width=1000,
            page_height=1000,
            panels=noisy,
            raw={"providerId": f"p-{self.calls}", "id": "drop-me", "label": "page"},
        )


def _panel(
    x: float,
    y: float,
    bubbles: tuple[DetectedBubble, ...] = (),
    *,
    width: float = 500,
    height: float = 500,
) -> DetectedPanel:
    return DetectedPanel(
        x=x,
        y=y,
        width=width,
        height=height,
        confidence=0.9,
        bubbles=bubbles,
        provider_id="original",
    )


def _bubble(text: str, polygon: tuple[tuple[float, float], ...]) -> DetectedBubble:
    return DetectedBubble(text=text, confidence=0.9, polygon=polygon, provider_id="bubble")


def _analyzer(panels: tuple[DetectedPanel, ...]) -> tuple[PanelAnalyzer, FixedDetector]:
    detector = FixedDetector(panels)
    return PanelAnalyzer(detector, provider_config_version="panel-v1"), detector


async def _analyze(panels: tuple[DetectedPanel, ...], direction: str):
    analyzer, detector = _analyzer(panels)
    page = await analyzer.analyze_page(
        image=PAGE,
        source_url="https://cdn.example/page.png",
        reading_direction=direction,
        publisher=RecordingPublisher(),
    )
    return page, detector


async def test_ltr_rtl_and_multicolumn_order() -> None:
    pair = (
        _panel(0, 0, (_bubble("left", POLYGON_A),)),
        _panel(500, 0, (_bubble("right", POLYGON_A),)),
    )
    ltr, _detector = await _analyze(pair, "ltr")
    rtl, _detector = await _analyze(pair, "rtl")
    assert [panel.bounds.x for panel in ltr.panels] == [0, 500]
    assert [panel.bounds.x for panel in rtl.panels] == [500, 0]
    assert [panel.reading_order for panel in ltr.panels] == [0, 1]
    assert [panel.panel_index for panel in ltr.panels] == [0, 1]

    grid = (_panel(0, 0), _panel(500, 0), _panel(0, 500), _panel(500, 500))
    ordered, _detector = await _analyze(grid, "ltr")
    mirrored, _detector = await _analyze(grid, "rtl")
    assert [(panel.bounds.x, panel.bounds.y) for panel in ordered.panels] == [
        (0, 0),
        (500, 0),
        (0, 500),
        (500, 500),
    ]
    assert [(panel.bounds.x, panel.bounds.y) for panel in mirrored.panels] == [
        (500, 0),
        (0, 0),
        (500, 500),
        (0, 500),
    ]


async def test_no_bubbles_duplicate_text_and_provider_replay() -> None:
    quiet, _detector = await _analyze((_panel(50, 50, width=900, height=900),), "ltr")
    assert quiet.gate.accepted is True
    assert quiet.panels[0].dialogues == []
    assert quiet.panels[0].shot_type == "environment"

    bubbles = (
        _bubble("hello", POLYGON_A),
        _bubble("hello", POLYGON_A),
        _bubble("hello", POLYGON_B),
        _bubble("one\ntwo", POLYGON_A),
    )
    panel = _panel(50, 50, bubbles, width=900, height=900)
    analyzer, detector = _analyzer((panel,))
    first = await analyzer.analyze_page(
        image=PAGE,
        source_url="https://cdn.example/page.png",
        reading_direction="ltr",
        publisher=RecordingPublisher(),
    )
    second = await analyzer.analyze_page(
        image=PAGE,
        source_url="https://cdn.example/page.png",
        reading_direction="ltr",
        publisher=RecordingPublisher(),
    )
    texts = [line.text for line in first.panels[0].dialogues]
    assert texts == ["hello", "one", "two", "hello"]
    keys = [line.stable_line_key for line in first.panels[0].dialogues]
    assert len(keys) == len(set(keys))
    assert first.panels[0].model_dump(mode="json") == second.panels[0].model_dump(mode="json")
    assert first.input_hash == second.input_hash
    assert first.raw == {"label": "page"}
    assert detector.calls == 2
    assert "noise-1" not in str(first.panels[0].model_dump(mode="json"))
