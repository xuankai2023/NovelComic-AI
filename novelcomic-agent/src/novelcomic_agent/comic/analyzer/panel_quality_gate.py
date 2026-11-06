"""Deterministic geometry, coverage, overlap, and OCR checks."""

from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True, slots=True)
class GateThresholds:
    min_area_ratio: float = 0.01
    min_coverage: float = 0.45
    overlap_warning: float = 0.35
    overlap_reject: float = 0.6
    ocr_warning: float = 0.55
    ocr_review: float = 0.2
    clamp_px: float = 2.0
    min_panel_confidence: float = 0.45


@dataclass(frozen=True, slots=True)
class GateLine:
    text: str
    confidence: float


@dataclass(frozen=True, slots=True)
class GatePanel:
    x: float
    y: float
    width: float
    height: float
    confidence: float
    lines: tuple[GateLine, ...] = ()


@dataclass(frozen=True, slots=True)
class PanelGateResult:
    accepted: bool
    warnings: tuple[str, ...]
    fallback_reason: str | None
    requires_manual_review: bool
    panels: tuple[GatePanel, ...]


def evaluate_panels(
    panels: list[GatePanel] | tuple[GatePanel, ...],
    *,
    page_width: float,
    page_height: float,
    thresholds: GateThresholds | None = None,
) -> PanelGateResult:
    """Accept a detection or replace it with one safe full-page panel."""

    rules = thresholds or GateThresholds()
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")
    if not panels:
        return _fallback((), "no-panels", page_width, page_height, ("no-panels",))

    clamped: list[GatePanel] = []
    warnings: list[str] = []
    review = False
    page_area = page_width * page_height
    for panel in panels:
        excess = _excess(panel, page_width, page_height)
        if excess > rules.clamp_px:
            return _fallback(panels, "geometry-out-of-bounds", page_width, page_height, warnings)
        if excess > 0:
            panel = _clamp(panel, page_width, page_height)
            warnings.append("clamped-bounds")
        if panel.width <= 0 or panel.height <= 0:
            return _fallback(panels, "geometry-out-of-bounds", page_width, page_height, warnings)
        if (panel.width * panel.height) / page_area < rules.min_area_ratio:
            return _fallback(panels, "panel-too-small", page_width, page_height, warnings)
        if panel.confidence < rules.min_panel_confidence:
            review = True
            warnings.append("low-panel-confidence")
        for line in panel.lines:
            if line.confidence < rules.ocr_review:
                review = True
            if line.confidence < rules.ocr_warning:
                warnings.append("low-ocr-confidence")
        clamped.append(panel)

    coverage = _coverage(clamped, page_area)
    if coverage < rules.min_coverage:
        return _fallback(panels, "low-coverage", page_width, page_height, warnings)
    for left_index, left in enumerate(clamped):
        for right in clamped[left_index + 1 :]:
            ratio = _overlap_ratio(left, right)
            if ratio > rules.overlap_reject:
                return _fallback(panels, "excessive-overlap", page_width, page_height, warnings)
            if ratio > rules.overlap_warning:
                warnings.append("panel-overlap")
    unique_warnings = tuple(dict.fromkeys(warnings))
    return PanelGateResult(
        accepted=True,
        warnings=unique_warnings,
        fallback_reason=None,
        requires_manual_review=review,
        panels=tuple(clamped),
    )


def _fallback(
    panels: tuple[GatePanel, ...] | list[GatePanel],
    reason: str,
    page_width: float,
    page_height: float,
    warnings: list[str] | tuple[str, ...],
) -> PanelGateResult:
    lines = tuple(line for panel in panels for line in panel.lines)
    full_page = GatePanel(
        x=0,
        y=0,
        width=page_width,
        height=page_height,
        confidence=0,
        lines=lines,
    )
    merged = tuple(dict.fromkeys((*warnings, reason)))
    return PanelGateResult(
        accepted=False,
        warnings=merged,
        fallback_reason=reason,
        requires_manual_review=True,
        panels=(full_page,),
    )


def _excess(panel: GatePanel, page_width: float, page_height: float) -> float:
    return max(
        0.0,
        -panel.x,
        -panel.y,
        panel.x + panel.width - page_width,
        panel.y + panel.height - page_height,
    )


def _clamp(panel: GatePanel, page_width: float, page_height: float) -> GatePanel:
    x = min(max(panel.x, 0), page_width)
    y = min(max(panel.y, 0), page_height)
    right = min(max(panel.x + panel.width, 0), page_width)
    bottom = min(max(panel.y + panel.height, 0), page_height)
    return replace(panel, x=x, y=y, width=max(right - x, 0), height=max(bottom - y, 0))


def _coverage(panels: list[GatePanel], page_area: float) -> float:
    total = sum(panel.width * panel.height for panel in panels)
    for index, left in enumerate(panels):
        for right in panels[index + 1 :]:
            total -= _intersection(left, right)
    return max(0.0, min(1.0, total / page_area))


def _overlap_ratio(left: GatePanel, right: GatePanel) -> float:
    smaller = min(left.width * left.height, right.width * right.height)
    if smaller <= 0:
        return 0.0
    return _intersection(left, right) / smaller


def _intersection(left: GatePanel, right: GatePanel) -> float:
    x1 = max(left.x, right.x)
    y1 = max(left.y, right.y)
    x2 = min(left.x + left.width, right.x + right.width)
    y2 = min(left.y + left.height, right.y + right.height)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return (x2 - x1) * (y2 - y1)
