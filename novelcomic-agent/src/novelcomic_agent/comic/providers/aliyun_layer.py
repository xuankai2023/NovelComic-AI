"""L1 layer provider powered by Aliyun SegmentHDCommonImage."""

from __future__ import annotations

import logging

import cv2
import httpx
import numpy as np

from novelcomic_agent.config import Settings

from ..analyzer.image_fetcher import ImageFetcher
from ..assets.l1_layer_service import (
    LayerProviderError,
    LayerSeparation,
    ProviderLayer,
)
from ..contracts.errors import ComicServiceError
from .aliyun_imageseg import (
    AliyunImageSegClient,
    AliyunImageSegError,
    AliyunImageSegSettings,
)
from .panel_separation import (
    PanelSeparation,
    decode_bgr,
    measure_layers,
    place_on_canvas,
)

logger = logging.getLogger(__name__)

_MIN_SUBJECT = 0.04
_MAX_SUBJECT = 0.78


class AliyunLayerProvider:
    """Separate one plate with Aliyun HD common segmentation + OpenCV fill."""

    def __init__(
        self,
        *,
        fetcher: ImageFetcher,
        client: AliyunImageSegClient,
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
    def from_settings(
        cls, settings: Settings, fetcher: ImageFetcher
    ) -> AliyunLayerProvider | None:
        seg = AliyunImageSegSettings(
            access_key_id=settings.aliyun_viapi_access_key_id.strip(),
            access_key_secret=settings.aliyun_viapi_access_key_secret.strip(),
            endpoint=(
                settings.aliyun_imageseg_endpoint.strip()
                or "imageseg.cn-shanghai.aliyuncs.com"
            ),
        )
        if not seg.access_key_id or not seg.access_key_secret:
            return None
        return cls(
            fetcher=fetcher,
            client=AliyunImageSegClient(seg),
            unit_price_fen=settings.comic_layer_unit_price_fen,
        )

    async def aclose(self) -> None:
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
        panel = decode_bgr(image)
        if panel is None:
            return _fallback(request_id, "unseparated")
        try:
            cutout = await self._client.segment_hd_common_image(image=image)
        except AliyunImageSegError as exc:
            logger.warning("Aliyun L1 failed for %s: %s", shot_id, exc.code)
            raise LayerProviderError(
                "segmentation-failed" if not exc.retryable else exc.code,
                permanent=not exc.retryable,
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("Aliyun L1 download failed for %s: %s", shot_id, exc)
            raise LayerProviderError("provider-temporary", permanent=False) from exc
        separation = _separation_from_cutout(panel, cutout.image)
        if separation is None:
            logger.info("Aliyun L1 kept shot %s on the original plate", shot_id)
            return _fallback(request_id, "unseparated")
        try:
            placed = place_on_canvas(
                separation,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )
        except (ValueError, cv2.error) as exc:
            logger.info("Aliyun L1 could not place shot %s: %s", shot_id, exc)
            return _fallback(request_id, "unseparated")
        if placed is None:
            return _fallback(request_id, "unseparated")
        x, y, width, height = placed.body_bounds
        logger.info(
            "Aliyun L1 separated shot %s job=%s",
            shot_id,
            cutout.job_id,
        )
        return LayerSeparation(
            provider_request_id=cutout.job_id or request_id,
            cost_fen=self._unit_price_fen,
            layers=(
                ProviderLayer(
                    semantic="background",
                    image=placed.background_png,
                    name="background",
                    motion_policy="static",
                    confidence=0.95,
                ),
                ProviderLayer(
                    semantic="body",
                    image=placed.body_png,
                    name="body",
                    bounds=(x, y, width, height),
                    anchor=(0.5, 0.5),
                    motion_policy="subtle",
                    confidence=0.95,
                ),
            ),
            recomposition_score=placed.recomposition_score,
            alpha_hole_ratio=placed.alpha_hole_ratio,
            edge_artifact_score=placed.edge_artifact_score,
            warnings=tuple(
                dict.fromkeys(["aliyun-hd-common", *placed.warnings])
            ),
            requires_fallback=False,
        )

    async def reconcile(self, request_id: str) -> LayerSeparation | None:
        del request_id
        return None


def _separation_from_cutout(
    panel_bgr: np.ndarray,
    cutout_png: bytes,
) -> PanelSeparation | None:
    cutout = cv2.imdecode(np.frombuffer(cutout_png, np.uint8), cv2.IMREAD_UNCHANGED)
    if cutout is None or cutout.ndim < 2:
        return None
    height, width = panel_bgr.shape[:2]
    if cutout.shape[0] != height or cutout.shape[1] != width:
        cutout = cv2.resize(cutout, (width, height), interpolation=cv2.INTER_LINEAR)
    if cutout.ndim == 2:
        mask = cutout
        character = cv2.cvtColor(panel_bgr, cv2.COLOR_BGR2BGRA)
        character[:, :, 3] = mask
    elif cutout.shape[2] == 4:
        mask = cutout[:, :, 3]
        character = cutout
        # Prefer original panel colors under the HD alpha for comic line fidelity.
        opaque = mask > 0
        character_bgr = character[:, :, :3]
        character_bgr[opaque] = panel_bgr[opaque]
        character[:, :, :3] = character_bgr
        character[:, :, 3] = mask
    else:
        return None
    if mask.dtype != np.uint8:
        mask = np.clip(mask, 0, 255).astype(np.uint8)
    ratio = float(np.count_nonzero(mask) / mask.size)
    if ratio < _MIN_SUBJECT or ratio > _MAX_SUBJECT:
        return None
    radius = max(3, min(12, min(height, width) // 80))
    filled = cv2.inpaint(panel_bgr, mask, radius, cv2.INPAINT_TELEA)
    background = np.where(mask[:, :, None] > 0, filled, panel_bgr)
    recomposition, holes, edge = measure_layers(panel_bgr, background, mask)
    return PanelSeparation(
        panel_bgr=panel_bgr,
        background_bgr=background,
        character_bgra=character,
        mask=mask,
        recomposition_score=recomposition,
        alpha_hole_ratio=holes,
        edge_artifact_score=edge,
        warnings=("aliyun-mask",),
    )


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

