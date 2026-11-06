"""Geometry gate: fallback, review, and accepted panels."""

from novelcomic_agent.comic.analyzer.panel_quality_gate import GateLine, GatePanel, evaluate_panels


def _panel(
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    confidence: float = 0.9,
    lines: tuple[GateLine, ...] = (),
) -> GatePanel:
    return GatePanel(
        x=x,
        y=y,
        width=width,
        height=height,
        confidence=confidence,
        lines=lines,
    )


def test_out_of_bounds_falls_back_to_the_full_page() -> None:
    result = evaluate_panels(
        (_panel(-5, 0, 900, 900, lines=(GateLine("kept", 0.9),)),),
        page_width=1000,
        page_height=1000,
    )
    assert result.accepted is False
    assert result.fallback_reason == "geometry-out-of-bounds"
    assert result.panels[0].width == 1000
    assert result.panels[0].lines[0].text == "kept"


def test_low_ocr_requests_review_without_dropping_the_panel() -> None:
    result = evaluate_panels(
        (_panel(50, 50, 900, 900, lines=(GateLine("soft", 0.15),)),),
        page_width=1000,
        page_height=1000,
    )
    assert result.accepted is True
    assert result.requires_manual_review is True
    assert "low-ocr-confidence" in result.warnings
    assert result.panels[0].width == 900


def test_excessive_overlap_falls_back() -> None:
    panel = _panel(50, 50, 900, 900)
    result = evaluate_panels((panel, panel), page_width=1000, page_height=1000)
    assert result.accepted is False
    assert result.fallback_reason == "excessive-overlap"
    assert len(result.panels) == 1
    assert result.panels[0].width == 1000
