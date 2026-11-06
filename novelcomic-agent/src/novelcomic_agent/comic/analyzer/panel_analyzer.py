"""Download-independent panel ordering, stable line keys, and L0 crops."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Protocol

from ..canonical import hash_content
from ..contracts.ids import make_stable_line_key, page_id_from_bytes
from ..contracts.panel_spec import (
    PanelBounds,
    PanelDiagnostics,
    PanelSpec,
    Point,
    RawLine,
)
from .image_size import canvas_for_image, measure_image, require_detected_size
from .panel_quality_gate import GateLine, GatePanel, PanelGateResult, evaluate_panels

_SPEAKER_ID = re.compile(r"^speaker:(unknown|[a-f0-9]{64}:\d+)$")
_ROW_OVERLAP = 0.5


@dataclass(frozen=True, slots=True)
class DetectedBubble:
    text: str
    confidence: float
    polygon: tuple[tuple[float, float], ...] | None = None
    speaker_key: str | None = None
    provider_id: str | None = None


@dataclass(frozen=True, slots=True)
class DetectedPanel:
    x: float
    y: float
    width: float
    height: float
    confidence: float
    bubbles: tuple[DetectedBubble, ...] = ()
    provider_id: str | None = None


@dataclass(frozen=True, slots=True)
class PageDetection:
    page_width: float
    page_height: float
    panels: tuple[DetectedPanel, ...]
    raw: dict[str, Any]


@dataclass(frozen=True, slots=True)
class AnalysisPage:
    page_id: str
    input_hash: str
    panels: tuple[PanelSpec, ...]
    gate: PanelGateResult
    raw: dict[str, Any]
    page_width: int = 0
    page_height: int = 0
    canvas_width: int = 1080
    canvas_height: int = 1920


class PanelDetector(Protocol):
    async def detect(
        self,
        *,
        page_id: str,
        image: bytes,
        reading_direction: str,
    ) -> PageDetection:
        """Return provider geometry. Provider ids are not part of the result identity."""


class PanelCropper(Protocol):
    def crop(
        self,
        image: bytes,
        *,
        x: float,
        y: float,
        width: float,
        height: float,
    ) -> bytes:
        """Return crop bytes for one accepted panel."""


class CropPublisher(Protocol):
    async def publish(self, *, page_id: str, panel_index: int, body: bytes) -> str:
        """Store crop bytes and return a durable HTTPS URL."""


class BoundsTaggedCropper:
    """Deterministic crop envelope used until a pixel cropper is injected."""

    def crop(
        self,
        image: bytes,
        *,
        x: float,
        y: float,
        width: float,
        height: float,
    ) -> bytes:
        header = f"{x:.4f},{y:.4f},{width:.4f},{height:.4f}\n".encode()
        return header + image


class PanelAnalyzer:
    """Order panels and lines without adopting provider ids or moving production state."""

    def __init__(
        self,
        detector: PanelDetector,
        *,
        provider_config_version: str,
        cropper: PanelCropper | None = None,
    ) -> None:
        self._detector = detector
        self._provider_config_version = provider_config_version
        self._cropper = cropper or BoundsTaggedCropper()

    @property
    def provider_config_version(self) -> str:
        return self._provider_config_version

    async def analyze_page(
        self,
        *,
        image: bytes,
        source_url: str,
        reading_direction: str,
        publisher: CropPublisher,
    ) -> AnalysisPage:
        page_id = page_id_from_bytes(image)
        detection = await self._detector.detect(
            page_id=page_id,
            image=image,
            reading_direction=reading_direction,
        )
        measured = measure_image(image)
        require_detected_size(measured, detection.page_width, detection.page_height)
        canvas_width, canvas_height = canvas_for_image(measured)
        ordered = order_panels(detection.panels, reading_direction)
        gated = evaluate_panels(
            [
                GatePanel(
                    x=panel.x,
                    y=panel.y,
                    width=panel.width,
                    height=panel.height,
                    confidence=panel.confidence,
                    lines=tuple(
                        GateLine(text=bubble.text, confidence=bubble.confidence)
                        for bubble in _dedupe_bubbles(panel.bubbles)
                    ),
                )
                for panel in ordered
            ],
            page_width=detection.page_width,
            page_height=detection.page_height,
        )
        specs: list[PanelSpec] = []
        for index, panel in enumerate(gated.panels):
            source_panel = ordered[index] if gated.accepted and index < len(ordered) else None
            bubbles = () if source_panel is None else _dedupe_bubbles(source_panel.bubbles)
            if not gated.accepted:
                bubbles = tuple(
                    bubble
                    for source in ordered
                    for bubble in _dedupe_bubbles(source.bubbles)
                )
            panel_url = source_url
            if gated.accepted:
                crop = self._cropper.crop(
                    image,
                    x=panel.x,
                    y=panel.y,
                    width=panel.width,
                    height=panel.height,
                )
                panel_url = await publisher.publish(page_id=page_id, panel_index=index, body=crop)
            specs.append(
                _panel_spec(
                    page_id=page_id,
                    source_url=source_url,
                    panel_url=panel_url,
                    panel=panel,
                    index=index,
                    bubbles=bubbles,
                    reading_direction=reading_direction,
                    gate=gated,
                )
            )
        return AnalysisPage(
            page_id=page_id,
            input_hash=analysis_input_hash(
                page_id,
                reading_direction,
                self._provider_config_version,
            ),
            panels=tuple(specs),
            gate=gated,
            raw=_raw_without_provider_ids(detection.raw),
            page_width=measured.width,
            page_height=measured.height,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
        )


def analysis_input_hash(
    page_id: str,
    reading_direction: str,
    provider_config_version: str,
) -> str:
    return hash_content(
        {
            "imageSizeCheck": "measured-canvas-v1",
            "pageId": page_id,
            "providerConfigVersion": provider_config_version,
            "readingDirection": reading_direction,
        }
    )


def order_panels(
    panels: tuple[DetectedPanel, ...] | list[DetectedPanel],
    reading_direction: str,
) -> tuple[DetectedPanel, ...]:
    """Group panels into rows, then order each row by reading direction."""

    remaining = sorted(panels, key=lambda panel: (panel.y, panel.x, panel.width, panel.height))
    rows: list[list[DetectedPanel]] = []
    for panel in remaining:
        if rows and _vertical_overlap(panel, _row_union(rows[-1])) >= _ROW_OVERLAP:
            rows[-1].append(panel)
        else:
            rows.append([panel])
    ordered: list[DetectedPanel] = []
    for row in rows:
        row.sort(key=lambda panel: panel.x, reverse=reading_direction == "rtl")
        ordered.extend(row)
    return tuple(ordered)


def _panel_spec(
    *,
    page_id: str,
    source_url: str,
    panel_url: str,
    panel: GatePanel,
    index: int,
    bubbles: tuple[DetectedBubble, ...],
    reading_direction: str,
    gate: PanelGateResult,
) -> PanelSpec:
    ordered_bubbles = _order_bubbles(bubbles, reading_direction)
    dialogues: list[RawLine] = []
    for bubble_index, bubble in enumerate(ordered_bubbles):
        clauses = [part.strip() for part in bubble.text.split("\n") if part.strip()]
        speaker_id = _speaker_id(bubble.speaker_key, page_id, bubble_index)
        for clause_index, text in enumerate(clauses):
            dialogues.append(
                RawLine(
                    stable_line_key=make_stable_line_key(
                        page_id,
                        index,
                        bubble_index,
                        clause_index,
                    ),
                    bubble_reading_order=bubble_index,
                    text=text,
                    speaker_id=speaker_id,  # type: ignore[arg-type]
                    bubble_polygon=_points(bubble.polygon),
                    ocr_confidence=bubble.confidence,
                )
            )
    shot_type = "environment" if not dialogues else "dialogue"
    return PanelSpec(
        page_id=page_id,
        panel_index=index,
        source_url=source_url,  # type: ignore[arg-type]
        panel_url=panel_url,  # type: ignore[arg-type]
        bounds=PanelBounds(x=panel.x, y=panel.y, width=panel.width, height=panel.height),
        reading_order=index,
        shot_type=shot_type,  # type: ignore[arg-type]
        dialogues=dialogues,
        diagnostics=PanelDiagnostics(
            panel_confidence=panel.confidence,
            requires_manual_review=gate.requires_manual_review,
            warnings=list(gate.warnings),
        ),
    )


def _dedupe_bubbles(bubbles: tuple[DetectedBubble, ...]) -> tuple[DetectedBubble, ...]:
    seen: set[tuple[str, tuple[tuple[float, float], ...]]] = set()
    kept: list[DetectedBubble] = []
    for bubble in bubbles:
        polygon = tuple((round(x, 2), round(y, 2)) for x, y in (bubble.polygon or ()))
        key = (" ".join(bubble.text.split()), polygon)
        if key in seen:
            continue
        seen.add(key)
        kept.append(bubble)
    return tuple(kept)


def _order_bubbles(
    bubbles: tuple[DetectedBubble, ...],
    reading_direction: str,
) -> tuple[DetectedBubble, ...]:
    decorated = [(_bubble_box(bubble, index), bubble) for index, bubble in enumerate(bubbles)]
    boxes = [
        DetectedPanel(
            x=box[0],
            y=box[1],
            width=box[2],
            height=box[3],
            confidence=1,
            provider_id=str(index),
        )
        for index, (box, _bubble) in enumerate(decorated)
    ]
    if not boxes:
        return ()
    order = order_panels(boxes, reading_direction)
    by_id = {panel.provider_id: decorated[int(panel.provider_id or 0)][1] for panel in boxes}
    return tuple(by_id[panel.provider_id or "0"] for panel in order)


def _bubble_box(bubble: DetectedBubble, index: int) -> tuple[float, float, float, float]:
    if not bubble.polygon:
        return (0.0, float(index), 1.0, 0.1)
    xs = [point[0] for point in bubble.polygon]
    ys = [point[1] for point in bubble.polygon]
    return (min(xs), min(ys), max(xs) - min(xs) or 1.0, max(ys) - min(ys) or 1.0)


def _speaker_id(speaker_key: str | None, page_id: str, bubble_index: int) -> str | None:
    if speaker_key is None or not speaker_key.strip():
        return None
    if _SPEAKER_ID.fullmatch(speaker_key):
        return speaker_key
    digest = hashlib.sha256(f"{page_id}:{speaker_key.strip().lower()}".encode()).hexdigest()
    return f"speaker:{digest}:{bubble_index}"


def _points(polygon: tuple[tuple[float, float], ...] | None) -> list[Point] | None:
    if polygon is None or len(polygon) < 3:
        return None
    return [Point(x=x, y=y) for x, y in polygon]


def _vertical_overlap(panel: DetectedPanel, bounds: tuple[float, float]) -> float:
    top, bottom = bounds
    overlap = min(panel.y + panel.height, bottom) - max(panel.y, top)
    if overlap <= 0 or panel.height <= 0:
        return 0.0
    return overlap / min(panel.height, bottom - top)


def _row_union(row: list[DetectedPanel]) -> tuple[float, float]:
    top = min(panel.y for panel in row)
    bottom = max(panel.y + panel.height for panel in row)
    return (top, bottom)


def _raw_without_provider_ids(raw: dict[str, Any]) -> dict[str, Any]:
    def scrub(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: scrub(item)
                for key, item in value.items()
                if key not in {"providerId", "provider_id", "id"}
            }
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    return scrub(raw)
