"""Crop a panel to PNG bytes from pixel or normalized bounds."""

from __future__ import annotations

from io import BytesIO

from PIL import Image


class PixelCropper:
    """Cut one panel out of the source page.

    Bounds are pixels when any edge falls outside the unit square. Values that
    all stay inside 0–1 are fractions of the page width and height.
    """

    def crop(
        self,
        image: bytes,
        *,
        x: float,
        y: float,
        width: float,
        height: float,
    ) -> bytes:
        with Image.open(BytesIO(image)) as source:
            if source.mode not in {"RGB", "RGBA", "L"}:
                source = source.convert("RGBA")
            left, upper, right, lower = _pixel_box(
                source.width,
                source.height,
                x,
                y,
                width,
                height,
            )
            cropped = source.crop((left, upper, right, lower))
            buffer = BytesIO()
            cropped.save(buffer, format="PNG")
            return buffer.getvalue()


def _pixel_box(
    image_width: int,
    image_height: int,
    x: float,
    y: float,
    width: float,
    height: float,
) -> tuple[int, int, int, int]:
    if _normalized(x, y, width, height):
        x *= image_width
        y *= image_height
        width *= image_width
        height *= image_height
    left = max(0, int(round(x)))
    upper = max(0, int(round(y)))
    right = min(image_width, int(round(x + width)))
    lower = min(image_height, int(round(y + height)))
    if right <= left or lower <= upper:
        raise ValueError("panel crop is empty")
    return left, upper, right, lower


def _normalized(x: float, y: float, width: float, height: float) -> bool:
    return all(0 <= value <= 1 for value in (x, y, width, height, x + width, y + height))
