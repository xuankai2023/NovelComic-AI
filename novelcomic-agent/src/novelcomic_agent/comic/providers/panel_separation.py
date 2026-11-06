"""Split one panel into a character cutout and an inpainted background.

The character pixels stay on the body layer. OpenCV fills the hole they leave,
so the background plate is not a blurred copy of the same crop.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

_MIN_SUBJECT = 0.04
_MAX_SUBJECT = 0.78
_MIN_COMPONENT = 0.02
_BLUR_RADIUS_PX = 28
_DIM_OPACITY = 0.45


@dataclass(frozen=True, slots=True)
class PanelSeparation:
    panel_bgr: np.ndarray
    background_bgr: np.ndarray
    character_bgra: np.ndarray
    mask: np.ndarray
    recomposition_score: float
    alpha_hole_ratio: float
    edge_artifact_score: float
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CanvasLayers:
    background_png: bytes
    body_png: bytes
    body_bounds: tuple[float, float, float, float]
    recomposition_score: float
    alpha_hole_ratio: float
    edge_artifact_score: float
    warnings: tuple[str, ...]


def separate_panel(image: bytes) -> PanelSeparation | None:
    """Return a character cutout and a background with that character removed."""

    panel = decode_bgr(image)
    if panel is None:
        return None
    mask = _character_mask(panel)
    if mask is None:
        return None
    radius = max(3, min(12, min(panel.shape[:2]) // 80))
    filled = cv2.inpaint(panel, mask, radius, cv2.INPAINT_TELEA)
    background = np.where(mask[:, :, None] > 0, filled, panel)
    character = cv2.cvtColor(panel, cv2.COLOR_BGR2BGRA)
    character[:, :, 3] = mask
    recomposition, holes, edge = measure_layers(panel, background, mask)
    return PanelSeparation(
        panel_bgr=panel,
        background_bgr=background,
        character_bgra=character,
        mask=mask,
        recomposition_score=recomposition,
        alpha_hole_ratio=holes,
        edge_artifact_score=edge,
    )


def replace_background(separation: PanelSeparation, background_bgr: np.ndarray) -> PanelSeparation:
    """Keep the character cutout and swap only the cleaned background."""

    recomposition, holes, edge = measure_layers(
        separation.panel_bgr,
        background_bgr,
        separation.mask,
    )
    return PanelSeparation(
        panel_bgr=separation.panel_bgr,
        background_bgr=background_bgr,
        character_bgra=separation.character_bgra,
        mask=separation.mask,
        recomposition_score=recomposition,
        alpha_hole_ratio=holes,
        edge_artifact_score=edge,
        warnings=separation.warnings,
    )


def apply_external_fill(
    panel_bgr: np.ndarray,
    fill_bgr: np.ndarray,
    mask: np.ndarray,
) -> np.ndarray:
    """Paste an external inpaint into the character hole and keep every other pixel."""

    fill = fill_bgr
    if fill.ndim == 2:
        fill = cv2.cvtColor(fill, cv2.COLOR_GRAY2BGR)
    if fill.shape[2] == 4:
        fill = cv2.cvtColor(fill, cv2.COLOR_BGRA2BGR)
    if fill.shape[:2] != panel_bgr.shape[:2]:
        fill = cv2.resize(
            fill,
            (panel_bgr.shape[1], panel_bgr.shape[0]),
            interpolation=cv2.INTER_LINEAR,
        )
    return np.where(mask[:, :, None] > 0, fill, panel_bgr).astype(np.uint8)


def place_on_canvas(
    separation: PanelSeparation,
    *,
    canvas_width: int,
    canvas_height: int,
) -> CanvasLayers | None:
    """Fit the clean plate and the character onto the output canvas.

    Letterbox pixels are a dimmed blur of the cleaned plate. They are not a
    blur of the original crop, so the character does not appear twice.
    """

    if canvas_width < 1 or canvas_height < 1:
        return None
    panel = separation.panel_bgr
    source_height, source_width = panel.shape[:2]
    x, y, placed_width, placed_height = _contain(
        source_width,
        source_height,
        canvas_width,
        canvas_height,
    )
    clean = _resize(separation.background_bgr, placed_width, placed_height)
    if placed_width == canvas_width and placed_height == canvas_height:
        background = clean
    else:
        background = _letterbox(separation.background_bgr, canvas_width, canvas_height)
        background[y : y + placed_height, x : x + placed_width] = clean
    character = _resize(separation.character_bgra, placed_width, placed_height)
    canvas = np.zeros((canvas_height, canvas_width, 4), np.uint8)
    canvas[y : y + placed_height, x : x + placed_width] = character
    cropped = _tight_crop(canvas)
    if cropped is None:
        return None
    body, bounds = cropped
    return CanvasLayers(
        background_png=encode_png(background),
        body_png=encode_png(body),
        body_bounds=bounds,
        recomposition_score=separation.recomposition_score,
        alpha_hole_ratio=separation.alpha_hole_ratio,
        edge_artifact_score=separation.edge_artifact_score,
        warnings=separation.warnings,
    )


def measure_layers(
    panel_bgr: np.ndarray,
    background_bgr: np.ndarray,
    mask: np.ndarray,
) -> tuple[float, float, float]:
    """Score a composite of the original character over the cleaned background."""

    recomposed = background_bgr.copy()
    subject = mask > 0
    recomposed[subject] = panel_bgr[subject]
    delta = np.abs(recomposed.astype(np.int16) - panel_bgr.astype(np.int16)).mean(axis=2)
    recomposition = float(delta.mean() / 255.0)
    kernel = np.ones((3, 3), np.uint8)
    boundary = cv2.subtract(cv2.dilate(mask, kernel), cv2.erode(mask, kernel))
    band = boundary > 0
    edge = float(delta[band].mean() / 255.0) if bool(band.any()) else 0.0
    return recomposition, _hole_ratio(mask), edge


def mask_area_ratio(mask: np.ndarray) -> float:
    return _ratio(mask)


def decode_bgr(image: bytes) -> np.ndarray | None:
    if not image:
        return None
    decoded = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None or decoded.ndim != 3 or decoded.shape[0] < 8 or decoded.shape[1] < 8:
        return None
    return decoded


def encode_png(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("png encode failed")
    return encoded.tobytes()


def _character_mask(panel: np.ndarray) -> np.ndarray | None:
    refined = _refine(_foreground_from_border(panel))
    if refined is not None:
        return refined
    try:
        grabbed = _grabcut_mask(panel)
    except cv2.error:
        return None
    return _refine(grabbed)


def _foreground_from_border(panel: np.ndarray) -> np.ndarray:
    height, width = panel.shape[:2]
    source = panel.copy()
    flood_mask = np.zeros((height + 2, width + 2), np.uint8)
    flags = cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8) | 4
    step = max(1, min(height, width) // 32)
    seeds: list[tuple[int, int]] = []
    for x in range(0, width, step):
        seeds.append((x, 0))
        seeds.append((x, height - 1))
    for y in range(0, height, step):
        seeds.append((0, y))
        seeds.append((width - 1, y))
    for x, y in seeds:
        if flood_mask[y + 1, x + 1] != 0:
            continue
        cv2.floodFill(
            source,
            flood_mask,
            (x, y),
            (0, 0, 0),
            (16, 16, 16),
            (16, 16, 16),
            flags,
        )
    background = flood_mask[1:-1, 1:-1]
    return np.where(background > 0, 0, 255).astype(np.uint8)


def _grabcut_mask(panel: np.ndarray) -> np.ndarray:
    height, width = panel.shape[:2]
    longest = max(height, width)
    work = panel
    if longest > 720:
        scale = 720 / longest
        work = cv2.resize(
            panel,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    work_height, work_width = work.shape[:2]
    margin_x = max(1, int(work_width * 0.06))
    margin_y = max(1, int(work_height * 0.06))
    rect = (
        margin_x,
        margin_y,
        max(1, work_width - 2 * margin_x),
        max(1, work_height - 2 * margin_y),
    )
    mask = np.zeros((work_height, work_width), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(work, mask, rect, bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
    subject = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    if subject.shape[:2] != (height, width):
        subject = cv2.resize(subject, (width, height), interpolation=cv2.INTER_NEAREST)
    return subject


def _refine(mask: np.ndarray) -> np.ndarray | None:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    filled = _fill_contours(closed)
    kept = _keep_subjects(filled)
    if not _MIN_SUBJECT <= _ratio(kept) <= _MAX_SUBJECT:
        return None
    halo = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.dilate(kept, halo, iterations=1)


def _fill_contours(mask: np.ndarray) -> np.ndarray:
    contours, _hierarchy = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    if contours:
        cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    return filled


def _keep_subjects(mask: np.ndarray) -> np.ndarray:
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        (mask > 0).astype(np.uint8),
        8,
    )
    kept = np.zeros_like(mask)
    if count <= 1:
        return kept
    total = mask.shape[0] * mask.shape[1]
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] / total >= _MIN_COMPONENT:
            kept[labels == index] = 255
    if np.count_nonzero(kept) == 0:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        if stats[largest, cv2.CC_STAT_AREA] / total >= _MIN_SUBJECT:
            kept[labels == largest] = 255
    return kept


def _hole_ratio(mask: np.ndarray) -> float:
    filled = _fill_contours(mask)
    subject = int(np.count_nonzero(filled))
    if subject == 0:
        return 1.0
    holes = cv2.bitwise_and(filled, cv2.bitwise_not(mask))
    return float(np.count_nonzero(holes)) / float(subject)


def _ratio(mask: np.ndarray) -> float:
    total = mask.shape[0] * mask.shape[1]
    if total == 0:
        return 0.0
    return float(np.count_nonzero(mask)) / float(total)


def _contain(
    source_width: int,
    source_height: int,
    canvas_width: int,
    canvas_height: int,
) -> tuple[int, int, int, int]:
    scale = min(canvas_width / source_width, canvas_height / source_height)
    width = max(1, _round(source_width * scale))
    height = max(1, _round(source_height * scale))
    return (
        _round((canvas_width - width) / 2),
        _round((canvas_height - height) / 2),
        width,
        height,
    )


def _letterbox(clean: np.ndarray, canvas_width: int, canvas_height: int) -> np.ndarray:
    source_height, source_width = clean.shape[:2]
    scale = max(canvas_width / source_width, canvas_height / source_height)
    cover_width = max(canvas_width, _round(source_width * scale))
    cover_height = max(canvas_height, _round(source_height * scale))
    covered = _resize(clean, cover_width, cover_height)
    x0 = max(0, (cover_width - canvas_width) // 2)
    y0 = max(0, (cover_height - canvas_height) // 2)
    cropped = covered[y0 : y0 + canvas_height, x0 : x0 + canvas_width]
    if cropped.shape[0] != canvas_height or cropped.shape[1] != canvas_width:
        cropped = _resize(cropped, canvas_width, canvas_height)
    blurred = _blur(cropped, _BLUR_RADIUS_PX)
    dimmed = np.clip(blurred.astype(np.float32) * (1.0 - _DIM_OPACITY), 0, 255)
    return dimmed.astype(np.uint8)


def _tight_crop(image: np.ndarray) -> tuple[np.ndarray, tuple[float, float, float, float]] | None:
    ys, xs = np.where(image[:, :, 3] > 16)
    if xs.size == 0:
        return None
    x0 = int(xs.min())
    y0 = int(ys.min())
    x1 = int(xs.max())
    y1 = int(ys.max())
    crop = image[y0 : y1 + 1, x0 : x1 + 1]
    return crop, (float(x0), float(y0), float(x1 - x0 + 1), float(y1 - y0 + 1))


def _resize(image: np.ndarray, width: int, height: int) -> np.ndarray:
    shrinking = width < image.shape[1] or height < image.shape[0]
    interpolation = cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR
    return cv2.resize(image, (width, height), interpolation=interpolation)


def _blur(image: np.ndarray, radius: int) -> np.ndarray:
    kernel = radius * 2 + 1
    limit = min(image.shape[0], image.shape[1])
    if kernel >= limit:
        kernel = limit if limit % 2 == 1 else limit - 1
    if kernel < 3:
        return image
    return cv2.GaussianBlur(image, (kernel, kernel), 0)


def _round(value: float) -> int:
    return int(math.floor(value + 0.5))
