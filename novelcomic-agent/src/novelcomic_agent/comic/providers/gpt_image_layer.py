"""L1 layer provider: character cutout, cleaned background, and hole fill."""

from __future__ import annotations

import logging

import cv2

from novelcomic_agent.config import Settings

from ..analyzer.image_fetcher import ImageFetcher
from ..assets.l1_layer_service import (
    LayerProviderError,
    LayerSeparation,
    ProviderLayer,
)
from ..contracts.errors import ComicServiceError
from .gpt_image_2 import GptImage2Client, GptImage2Error, GptImage2Settings
from .panel_separation import (
    apply_external_fill,
    decode_bgr,
    mask_area_ratio,
    place_on_canvas,
    replace_background,
    separate_panel,
)

logger = logging.getLogger(__name__)

_LARGE_HOLE = 0.08
_INPAINT_PROMPT = (
    "Remove every person, character, and creature from this comic panel. "
    "Inpaint only the area they covered so the background scenery, line art, "
    "and colors continue naturally. Do not add new characters, objects, or text. "
    "Keep the original framing, borders, and background."
)


class GptImageLayerProvider:
    """Separate one plate into a body layer and an inpainted background.

    OpenCV fills the character hole. A configured GPT Image client repaints a
    large hole. ``reconcile`` does not call the model again.
    """

    def __init__(
        self,
        *,
        fetcher: ImageFetcher,
        client: GptImage2Client | None = None,
        unit_price_fen: int = 0,
    ) -> None:
        if (
            isinstance(unit_price_fen, bool)
            or not isinstance(unit_price_fen, int)
            or unit_price_fen < 0
        ):
            raise ValueError("COMIC_LAYER_UNIT_PRICE_FEN must be a non-negative integer")
        self._fetcher = fetcher
        self._client = client
        self._unit_price_fen = unit_price_fen

    @classmethod
    def from_settings(cls, settings: Settings, fetcher: ImageFetcher) -> GptImageLayerProvider:
        gpt = GptImage2Settings.from_env()
        client = None
        if gpt.baidu_api_key or gpt.tencent_api_key:
            client = GptImage2Client(gpt)
        return cls(
            fetcher=fetcher,
            client=client,
            unit_price_fen=settings.comic_layer_unit_price_fen,
        )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def separate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
    ) -> LayerSeparation:
        del model_version, parameter_version
        try:
            image = await self._fetcher.fetch(source_url)
        except ComicServiceError as exc:
            raise LayerProviderError(exc.code, permanent=not exc.body.retryable) from exc
        separation = separate_panel(image)
        if separation is None:
            logger.info("L1 kept shot %s on the original plate", shot_id)
            return _fallback(request_id, "unseparated")
        warnings = list(separation.warnings)
        cost_fen = 0
        if self._client is not None and mask_area_ratio(separation.mask) >= _LARGE_HOLE:
            try:
                edited = await self._client.edit(
                    prompt=_INPAINT_PROMPT,
                    image=image,
                    image_url=source_url,
                    quality="medium",
                    aspect_ratio=_aspect_ratio(canvas_width, canvas_height),
                )
            except GptImage2Error as exc:
                logger.warning("L1 inpaint API failed for %s: %s", shot_id, exc)
                warnings.append("inpaint-api-failed")
            else:
                fill = decode_bgr(edited.image)
                if fill is None:
                    warnings.append("inpaint-api-failed")
                else:
                    background = apply_external_fill(
                        separation.panel_bgr,
                        fill,
                        separation.mask,
                    )
                    separation = replace_background(separation, background)
                    cost_fen = self._unit_price_fen
                    warnings.append("inpaint-api")
        try:
            placed = place_on_canvas(
                separation,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )
        except (ValueError, cv2.error) as exc:
            logger.info("L1 could not place shot %s: %s", shot_id, exc)
            return _fallback(request_id, "unseparated")
        if placed is None:
            return _fallback(request_id, "unseparated")
        x, y, width, height = placed.body_bounds
        logger.info("L1 separated shot %s into a character and a cleaned background", shot_id)
        return LayerSeparation(
            provider_request_id=request_id,
            cost_fen=cost_fen,
            layers=(
                ProviderLayer(
                    semantic="background",
                    image=placed.background_png,
                    name="background",
                    motion_policy="static",
                    confidence=0.9,
                ),
                ProviderLayer(
                    semantic="body",
                    image=placed.body_png,
                    name="body",
                    bounds=(x, y, width, height),
                    anchor=(0.5, 0.5),
                    motion_policy="subtle",
                    confidence=0.9,
                ),
            ),
            recomposition_score=placed.recomposition_score,
            alpha_hole_ratio=placed.alpha_hole_ratio,
            edge_artifact_score=placed.edge_artifact_score,
            warnings=tuple(dict.fromkeys([*warnings, *placed.warnings])),
            requires_fallback=False,
        )

    async def reconcile(self, request_id: str) -> LayerSeparation | None:
        del request_id
        return None


def _fallback(request_id: str, reason: str) -> LayerSeparation:
    return LayerSeparation(
        provider_request_id=request_id,
        cost_fen=0,
        layers=(),
        recomposition_score=1.0,
        alpha_hole_ratio=1.0,
        edge_artifact_score=1.0,
        warnings=(reason,),
        requires_fallback=True,
    )


def _aspect_ratio(width: int, height: int) -> str:
    if height > width * 1.2:
        return "9:16"
    if width > height * 1.2:
        return "16:9"
    return "1:1"
