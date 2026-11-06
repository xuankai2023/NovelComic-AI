"""Page OCR. The detector assigns bubbles to panels and does not rewrite text."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..contracts.errors import ComicServiceError


@dataclass(frozen=True, slots=True)
class OcrBubble:
    text: str
    confidence: float
    polygon: tuple[tuple[float, float], ...] | None = None


class OcrEngine(Protocol):
    async def recognize(self, image: bytes) -> tuple[OcrBubble, ...]:
        """Read bubbles from one page image. Coordinates are in that image."""


class HttpOcrEngine:
    """POST a page image and return the provider's text, confidence, and polygon."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not endpoint.strip() or not api_key.strip():
            raise ValueError("OCR endpoint and API key are required")
        self._endpoint = endpoint.strip()
        self._api_key = api_key.strip()
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def recognize(self, image: bytes) -> tuple[OcrBubble, ...]:
        try:
            response = await self._client.post(
                self._endpoint,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"imageBase64": base64.b64encode(image).decode("ascii")},
            )
        except httpx.TimeoutException as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider timed out",
                retryable=True,
            ) from exc
        unavailable = response.status_code in {408, 429} or response.status_code >= 500
        if unavailable:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider is unavailable",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider rejected the page",
                retryable=False,
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider returned invalid JSON",
                retryable=False,
            ) from exc
        if not isinstance(payload, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider returned invalid JSON",
                retryable=False,
            )
        return _bubbles(payload)


def _bubbles(payload: dict[str, object]) -> tuple[OcrBubble, ...]:
    raw_items = payload.get("bubbles", [])
    if not isinstance(raw_items, list):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "ocr provider returned invalid bubbles",
            retryable=False,
        )
    bubbles: list[OcrBubble] = []
    for item in raw_items:
        if not isinstance(item, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "ocr provider returned invalid bubbles",
                retryable=False,
            )
        text = item.get("text")
        if not isinstance(text, str) or text == "":
            continue
        confidence = _confidence(item.get("confidence"))
        bubbles.append(
            OcrBubble(
                text=text,
                confidence=confidence,
                polygon=_polygon(item.get("polygon")),
            )
        )
    return tuple(bubbles)


def _confidence(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "ocr provider returned invalid confidence",
            retryable=False,
        )
    confidence = float(value)
    if confidence < 0 or confidence > 1:
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "ocr provider returned invalid confidence",
            retryable=False,
        )
    return confidence


def _polygon(value: object) -> tuple[tuple[float, float], ...] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) < 3:
        return None
    points: list[tuple[float, float]] = []
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            return None
        x, y = point
        if isinstance(x, bool) or isinstance(y, bool):
            return None
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return None
        points.append((float(x), float(y)))
    return tuple(points)
