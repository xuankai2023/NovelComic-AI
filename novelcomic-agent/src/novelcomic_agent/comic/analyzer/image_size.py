"""Read a page's real pixels before any panel crop."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, UnidentifiedImageError

LANDSCAPE_CANVAS = (1920, 1080)
PORTRAIT_CANVAS = (1080, 1920)


class ImageDimensionError(Exception):
    """The decoded page does not match the size the detector used."""


@dataclass(frozen=True, slots=True)
class ImageSize:
    width: int
    height: int


def measure_image(image: bytes) -> ImageSize:
    """Decode the page and return its pixel size. This does not crop."""

    try:
        with Image.open(BytesIO(image)) as source:
            source.load()
            width, height = source.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageDimensionError("page image could not be measured") from exc
    if width < 1 or height < 1:
        raise ImageDimensionError("page image dimensions must be positive")
    return ImageSize(width=width, height=height)


def canvas_for_image(size: ImageSize) -> tuple[int, int]:
    """Landscape pages render 16:9. Portrait pages render 9:16."""

    if size.width >= size.height:
        return LANDSCAPE_CANVAS
    return PORTRAIT_CANVAS


def require_detected_size(size: ImageSize, page_width: float, page_height: float) -> None:
    """Refuse to crop when the detector's page size is not the measured image."""

    if int(page_width) != size.width or int(page_height) != size.height:
        raise ImageDimensionError(
            f"image is {size.width}x{size.height}, "
            f"detector reported {int(page_width)}x{int(page_height)}"
        )
