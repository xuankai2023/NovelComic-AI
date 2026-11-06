"""Deterministic OpenCV panel detection. Reading order stays in the analyzer."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import cv2
import numpy as np

from novelcomic_agent.config import Settings

from ..analyzer.panel_analyzer import DetectedBubble, DetectedPanel, PageDetection
from ..contracts.errors import ComicServiceError
from .ocr import HttpOcrEngine, OcrBubble, OcrEngine

logger = logging.getLogger(__name__)

_ADAPTIVE_BLOCK = 31
_ADAPTIVE_C = 8
_MAX_LINE_THICKNESS = 15
_WHITE_LEVEL = 245
_WHITE_FRACTION = 0.9
_MIN_AREA_RATIO = 0.02
_MIN_SIDE_RATIO = 0.08
_MAX_GUTTER_RATIO = 0.08
_MIN_GUTTER_PX = 4
_MERGE_GAP_RATIO = 0.018
_MIN_MERGE_GAP_PX = 12
_BORDER_BAND_PX = 8
_MIN_SIDE_HIT = 0.22
_MIN_SUPPORTED_SIDES = 3
_ALGORITHM = "opencv-panel-v1"


@dataclass(frozen=True, slots=True)
class _Box:
    x: int
    y: int
    width: int
    height: int
    confidence: float

    def union(self, other: _Box) -> _Box:
        right = max(self.x + self.width, other.x + other.width)
        bottom = max(self.y + self.height, other.y + other.height)
        return _Box(
            x=min(self.x, other.x),
            y=min(self.y, other.y),
            width=right - min(self.x, other.x),
            height=bottom - min(self.y, other.y),
            confidence=max(self.confidence, other.confidence),
        )


@dataclass(frozen=True, slots=True)
class _Geometry:
    width: int
    height: int
    boxes: tuple[_Box, ...]


class OpenCvPanelDetector:
    """Find panel boxes, then fill each box from one page OCR call."""

    def __init__(self, ocr: OcrEngine | None = None) -> None:
        self._ocr = ocr

    @classmethod
    def from_settings(cls, settings: Settings) -> OpenCvPanelDetector:
        endpoint = settings.comic_ocr_endpoint.strip()
        api_key = settings.comic_ocr_api_key.strip()
        if endpoint and api_key:
            return cls(ocr=HttpOcrEngine(endpoint=endpoint, api_key=api_key))
        if endpoint or api_key:
            logger.warning(
                "comic OCR is disabled because COMIC_OCR_ENDPOINT and COMIC_OCR_API_KEY "
                "must both be set"
            )
        return cls()

    async def aclose(self) -> None:
        closer = getattr(self._ocr, "aclose", None)
        if closer is None:
            return
        result = closer()
        if asyncio.iscoroutine(result):
            await result

    async def detect(
        self,
        *,
        page_id: str,
        image: bytes,
        reading_direction: str,
    ) -> PageDetection:
        del page_id
        geometry = await asyncio.to_thread(_detect_geometry, image)
        bubbles: tuple[OcrBubble, ...] = ()
        if self._ocr is not None:
            bubbles = await self._ocr.recognize(image)
        panels = _assign_bubbles(geometry.boxes, bubbles)
        return PageDetection(
            page_width=float(geometry.width),
            page_height=float(geometry.height),
            panels=panels,
            raw={
                "algorithm": _ALGORITHM,
                "readingDirection": reading_direction,
                "pageWidth": geometry.width,
                "pageHeight": geometry.height,
                "panels": [
                    {
                        "x": box.x,
                        "y": box.y,
                        "width": box.width,
                        "height": box.height,
                        "confidence": box.confidence,
                    }
                    for box in geometry.boxes
                ],
            },
        )


def _detect_geometry(image: bytes) -> _Geometry:
    page = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
    if page is None:
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "page image could not be decoded",
            retryable=False,
        )
    height, width = page.shape[:2]
    if width < 32 or height < 32:
        return _Geometry(width=width, height=height, boxes=())
    gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    separators = _separators(gray)
    boxes = _boxes_from_separators(separators, width, height)
    return _Geometry(width=width, height=height, boxes=tuple(boxes))


def _separators(gray: np.ndarray) -> np.ndarray:
    height, width = gray.shape[:2]
    block = _odd_block(min(width, height))
    adaptive = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block,
        _ADAPTIVE_C,
    )
    lines = _long_lines(adaptive, width, height)
    gutters = _whitespace_gutters(gray)
    separators = cv2.bitwise_or(lines, gutters)
    return cv2.dilate(separators, np.ones((3, 3), dtype=np.uint8), iterations=1)


def _odd_block(limit: int) -> int:
    block = min(_ADAPTIVE_BLOCK, limit - 1 if limit % 2 == 0 else limit)
    if block % 2 == 0:
        block -= 1
    return max(block, 3)


def _long_lines(ink: np.ndarray, width: int, height: int) -> np.ndarray:
    """Keep thin rules. A filled region is not a panel border."""

    horizontal_length = max(12, min(width // 25, width - 1))
    vertical_length = max(12, min(height // 25, height - 1))
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_length, 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_length))
    thickness = cv2.getStructuringElement(cv2.MORPH_RECT, (1, _MAX_LINE_THICKNESS))
    thickness_horizontal = cv2.getStructuringElement(cv2.MORPH_RECT, (_MAX_LINE_THICKNESS, 1))
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, vertical_kernel)
    horizontal = cv2.subtract(horizontal, cv2.morphologyEx(horizontal, cv2.MORPH_OPEN, thickness))
    vertical = cv2.subtract(
        vertical,
        cv2.morphologyEx(vertical, cv2.MORPH_OPEN, thickness_horizontal),
    )
    return cv2.bitwise_or(horizontal, vertical)


def _whitespace_gutters(gray: np.ndarray) -> np.ndarray:
    height, width = gray.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    white = gray >= _WHITE_LEVEL
    max_run = max(_MIN_GUTTER_PX, int(min(width, height) * _MAX_GUTTER_RATIO))
    _paint_runs(mask, white.mean(axis=0), axis="column", max_run=max_run)
    _paint_runs(mask, white.mean(axis=1), axis="row", max_run=max_run)
    return mask


def _paint_runs(mask: np.ndarray, fractions: np.ndarray, *, axis: str, max_run: int) -> None:
    start: int | None = None
    for index in range(len(fractions) + 1):
        is_white = index < len(fractions) and float(fractions[index]) >= _WHITE_FRACTION
        if is_white and start is None:
            start = index
            continue
        if is_white or start is None:
            continue
        length = index - start
        if _MIN_GUTTER_PX <= length <= max_run:
            if axis == "column":
                mask[:, start:index] = 255
            else:
                mask[start:index, :] = 255
        start = None


def _boxes_from_separators(separators: np.ndarray, width: int, height: int) -> list[_Box]:
    interior = cv2.bitwise_not(separators)
    contours, _hierarchy = cv2.findContours(interior, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    page_area = float(width * height)
    min_area = _MIN_AREA_RATIO * page_area
    min_width = _MIN_SIDE_RATIO * width
    min_height = _MIN_SIDE_RATIO * height
    boxes: list[_Box] = []
    for contour in contours:
        x, y, box_width, box_height = (int(value) for value in cv2.boundingRect(contour))
        x, y, box_width, box_height = _clamp(x, y, box_width, box_height, width, height)
        if box_width < min_width or box_height < min_height:
            continue
        if box_width * box_height < min_area:
            continue
        sides = _side_hits(separators, x, y, box_width, box_height)
        supported = sum(1 for hit in sides if hit >= _MIN_SIDE_HIT)
        if supported < _MIN_SUPPORTED_SIDES:
            continue
        area = float(cv2.contourArea(contour))
        rectangularity = area / float(box_width * box_height) if box_width and box_height else 0.0
        confidence = min(1.0, max(0.0, 0.35 + 0.45 * rectangularity + 0.05 * supported))
        boxes.append(
            _Box(
                x=x,
                y=y,
                width=box_width,
                height=box_height,
                confidence=round(confidence, 4),
            )
        )
    max_gap = max(_MIN_MERGE_GAP_PX, int(min(width, height) * _MERGE_GAP_RATIO))
    merged = _merge_boxes(boxes, max_gap)
    merged.sort(key=lambda box: (box.y, box.x, box.width, box.height))
    return merged


def _clamp(
    x: int,
    y: int,
    width: int,
    height: int,
    page_width: int,
    page_height: int,
) -> tuple[int, int, int, int]:
    x = min(max(x, 0), page_width - 1)
    y = min(max(y, 0), page_height - 1)
    width = min(max(width, 1), page_width - x)
    height = min(max(height, 1), page_height - y)
    return x, y, width, height


def _side_hits(
    separators: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
) -> tuple[float, float, float, float]:
    page_height, page_width = separators.shape[:2]
    band = _BORDER_BAND_PX

    def fraction(x0: int, y0: int, x1: int, y1: int) -> float:
        x0 = max(0, x0)
        y0 = max(0, y0)
        x1 = min(page_width, x1)
        y1 = min(page_height, y1)
        if x1 <= x0 or y1 <= y0:
            return 0.0
        region = separators[y0:y1, x0:x1]
        if region.size == 0:
            return 0.0
        return float(np.count_nonzero(region)) / float(region.size)

    return (
        fraction(x, y - band, x + width, y + band),
        fraction(x + width - band, y, x + width + band, y + height),
        fraction(x, y + height - band, x + width, y + height + band),
        fraction(x - band, y, x + band, y + height),
    )


def _merge_boxes(boxes: list[_Box], max_gap: int) -> list[_Box]:
    merged = list(boxes)
    changed = True
    while changed:
        changed = False
        for index in range(len(merged)):
            for other in range(index + 1, len(merged)):
                if not _can_merge(merged[index], merged[other], max_gap):
                    continue
                merged[index] = merged[index].union(merged[other])
                del merged[other]
                changed = True
                break
            if changed:
                break
    return merged


def _can_merge(left: _Box, right: _Box, max_gap: int) -> bool:
    if _iou(left, right) >= 0.5:
        return True
    horizontal_gap = _span_gap(left.x, left.x + left.width, right.x, right.x + right.width)
    vertical_overlap = _overlap_ratio(left.y, left.y + left.height, right.y, right.y + right.height)
    vertical_gap = _span_gap(left.y, left.y + left.height, right.y, right.y + right.height)
    horizontal_overlap = _overlap_ratio(left.x, left.x + left.width, right.x, right.x + right.width)
    if (
        horizontal_gap is not None
        and horizontal_gap <= max_gap
        and vertical_overlap >= 0.6
    ):
        return True
    return vertical_gap is not None and vertical_gap <= max_gap and horizontal_overlap >= 0.6


def _span_gap(start_a: int, end_a: int, start_b: int, end_b: int) -> int | None:
    if end_a <= start_b:
        return start_b - end_a
    if end_b <= start_a:
        return start_a - end_b
    return None


def _overlap_ratio(start_a: int, end_a: int, start_b: int, end_b: int) -> float:
    overlap = min(end_a, end_b) - max(start_a, start_b)
    if overlap <= 0:
        return 0.0
    shorter = min(end_a - start_a, end_b - start_b)
    if shorter <= 0:
        return 0.0
    return overlap / shorter


def _iou(left: _Box, right: _Box) -> float:
    area = _intersection(left, right)
    union = left.width * left.height + right.width * right.height - area
    if union <= 0:
        return 0.0
    return area / union


def _intersection(left: _Box, right: _Box) -> float:
    x1 = max(left.x, right.x)
    y1 = max(left.y, right.y)
    x2 = min(left.x + left.width, right.x + right.width)
    y2 = min(left.y + left.height, right.y + right.height)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return float((x2 - x1) * (y2 - y1))


def _assign_bubbles(
    boxes: tuple[_Box, ...],
    bubbles: tuple[OcrBubble, ...],
) -> tuple[DetectedPanel, ...]:
    grouped: list[list[DetectedBubble]] = [[] for _box in boxes]
    for bubble in bubbles:
        index = _panel_index(boxes, bubble)
        if index is None:
            continue
        grouped[index].append(
            DetectedBubble(
                text=bubble.text,
                confidence=bubble.confidence,
                polygon=bubble.polygon,
            )
        )
    return tuple(
        DetectedPanel(
            x=float(box.x),
            y=float(box.y),
            width=float(box.width),
            height=float(box.height),
            confidence=box.confidence,
            bubbles=tuple(grouped[index]),
        )
        for index, box in enumerate(boxes)
    )


def _panel_index(boxes: tuple[_Box, ...], bubble: OcrBubble) -> int | None:
    if not bubble.polygon:
        return None
    xs = [point[0] for point in bubble.polygon]
    ys = [point[1] for point in bubble.polygon]
    box = _Box(
        x=int(min(xs)),
        y=int(min(ys)),
        width=max(int(max(xs) - min(xs)), 1),
        height=max(int(max(ys) - min(ys)), 1),
        confidence=1,
    )
    best_index: int | None = None
    best_area = 0.0
    for index, panel in enumerate(boxes):
        area = _intersection(panel, box)
        if area > best_area:
            best_area = area
            best_index = index
    if best_index is not None:
        return best_index
    center_x = (min(xs) + max(xs)) / 2
    center_y = (min(ys) + max(ys)) / 2
    for index, panel in enumerate(boxes):
        inside_x = panel.x <= center_x <= panel.x + panel.width
        inside_y = panel.y <= center_y <= panel.y + panel.height
        if inside_x and inside_y:
            return index
    return None
