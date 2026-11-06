"""Aliyun HD common segmentation builds L1 body + cleaned background."""

from __future__ import annotations

import cv2
import numpy as np

from novelcomic_agent.comic.providers.aliyun_imageseg import (
    AliyunSegmentCutout,
    _parse_result_image_url,
)
from novelcomic_agent.comic.providers.aliyun_layer import (
    AliyunLayerProvider,
    _separation_from_cutout,
)
from novelcomic_agent.comic.providers.panel_separation import decode_bgr
from novelcomic_agent.comic.assets.l1_layer_service import png_color_type

_SHOT = "shot-1"


class _Fetcher:
    def __init__(self, image: bytes) -> None:
        self.image = image

    async def fetch(self, url: str) -> bytes:
        del url
        return self.image


class _FakeSeg:
    def __init__(self, cutout: bytes) -> None:
        self.cutout = cutout
        self.calls = 0

    async def segment_hd_common_image(self, *, image: bytes) -> AliyunSegmentCutout:
        del image
        self.calls += 1
        return AliyunSegmentCutout(job_id="job-hd-1", image=self.cutout)

    async def aclose(self) -> None:
        return None


def _panel_and_cutout() -> tuple[bytes, bytes]:
    width, height = 160, 200
    image = np.zeros((height, width, 3), np.uint8)
    image[:, :] = (220, 40, 20)
    x0, y0, x1, y1 = 40, 50, 120, 150
    image[y0:y1, x0:x1] = (20, 30, 230)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    cutout = np.zeros((height, width, 4), np.uint8)
    cutout[y0:y1, x0:x1, :3] = image[y0:y1, x0:x1]
    cutout[y0:y1, x0:x1, 3] = 255
    ok2, cut_encoded = cv2.imencode(".png", cutout)
    assert ok2
    return encoded.tobytes(), cut_encoded.tobytes()


def test_parse_result_image_url_from_json() -> None:
    assert (
        _parse_result_image_url('{"ImageUrl":"https://oss.example/a.png"}')
        == "https://oss.example/a.png"
    )
    assert _parse_result_image_url("https://oss.example/b.png") == "https://oss.example/b.png"
    assert _parse_result_image_url("{bad") is None


def test_separation_from_cutout_builds_mask_and_background() -> None:
    panel_bytes, cutout_bytes = _panel_and_cutout()
    panel = decode_bgr(panel_bytes)
    assert panel is not None
    separation = _separation_from_cutout(panel, cutout_bytes)
    assert separation is not None
    assert separation.alpha_hole_ratio < 0.05
    assert int(separation.mask[100, 80]) == 255
    assert int(separation.mask[4, 4]) == 0


async def test_aliyun_provider_returns_body_and_background() -> None:
    panel_bytes, cutout_bytes = _panel_and_cutout()
    provider = AliyunLayerProvider(
        fetcher=_Fetcher(panel_bytes),
        client=_FakeSeg(cutout_bytes),  # type: ignore[arg-type]
        unit_price_fen=2,
    )
    separation = await provider.separate(
        request_id="req-1",
        shot_id=_SHOT,
        source_url="https://cdn.example/panel.png",
        canvas_width=108,
        canvas_height=192,
        model_version="layer-v1",
        parameter_version="params-v1",
    )
    assert separation.requires_fallback is False
    assert separation.provider_request_id == "job-hd-1"
    assert separation.cost_fen == 2
    assert "aliyun-hd-common" in separation.warnings
    assert [layer.semantic for layer in separation.layers] == ["background", "body"]
    assert png_color_type(separation.layers[0].image) == 2
    assert png_color_type(separation.layers[1].image) == 6
    assert await provider.reconcile("req-1") is None
