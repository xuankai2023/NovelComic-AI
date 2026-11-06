"""L1 separation produces a character cutout and an inpainted background."""

from __future__ import annotations

import cv2
import numpy as np

from novelcomic_agent.comic.assets.l0_panel import l0_asset_id, l0_foreground_item_id
from novelcomic_agent.comic.assets.l1_layer_service import png_color_type
from novelcomic_agent.comic.providers.gpt_image_2 import GptImage2Image
from novelcomic_agent.comic.providers.gpt_image_layer import GptImageLayerProvider
from novelcomic_agent.comic.providers.panel_separation import decode_bgr, separate_panel
from novelcomic_agent.comic.workers.asset_worker import _l1_display_ok

_SHOT = "shot-1"


class _Fetcher:
    def __init__(self, image: bytes) -> None:
        self.image = image

    async def fetch(self, url: str) -> bytes:
        del url
        return self.image


class _GreenFill:
    def __init__(self, size: tuple[int, int]) -> None:
        self.size = size
        self.calls = 0

    async def edit(self, **kwargs: object) -> GptImage2Image:
        del kwargs
        self.calls += 1
        image = np.zeros((self.size[1], self.size[0], 3), np.uint8)
        image[:, :] = (0, 255, 0)
        ok, encoded = cv2.imencode(".png", image)
        assert ok
        return GptImage2Image(
            model_id="edit",
            provider="fake",
            provider_request_id="fill-1",
            image=encoded.tobytes(),
            mime_type="image/png",
        )

    async def aclose(self) -> None:
        return None


def _panel() -> tuple[bytes, tuple[int, int, int, int]]:
    width, height = 160, 200
    image = np.zeros((height, width, 3), np.uint8)
    image[:, :] = (220, 40, 20)
    x0, y0, x1, y1 = 40, 50, 120, 150
    image[y0:y1, x0:x1] = (20, 30, 230)
    image[y0 + 30 : y0 + 55, x0 + 25 : x0 + 50] = (240, 240, 240)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return encoded.tobytes(), (x0, y0, x1, y1)


def test_separate_panel_inpaints_the_character_and_keeps_an_alpha_cutout() -> None:
    encoded, (x0, y0, x1, y1) = _panel()
    separation = separate_panel(encoded)
    assert separation is not None
    assert separation.recomposition_score < 0.05
    assert separation.alpha_hole_ratio < 0.05
    assert separation.edge_artifact_score < 0.08
    background = separation.background_bgr
    subject = background[y0 + 8 : y1 - 8, x0 + 8 : x1 - 8]
    assert float(subject[:, :, 2].mean()) < 80
    assert float(subject[:, :, 0].mean()) > 120
    alpha = separation.character_bgra[:, :, 3]
    assert int(alpha[(y0 + y1) // 2, (x0 + x1) // 2]) == 255
    assert int(alpha[y0 + 40, x0 + 35]) == 255
    assert int(alpha[4, 4]) == 0


def test_uniform_plate_does_not_invent_a_character() -> None:
    image = np.full((80, 80, 3), 180, np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    assert separate_panel(encoded.tobytes()) is None


def test_visible_blur_plate_is_not_an_l1_display() -> None:
    shot_id = _SHOT
    project = {
        "assets": {l0_asset_id(shot_id): {"id": l0_asset_id(shot_id)}},
        "items": {l0_foreground_item_id(shot_id): {"id": l0_foreground_item_id(shot_id)}},
        "tracks": [
            {"id": f"track:{shot_id}:panel-foreground", "hidden": True},
            {"id": f"track:{shot_id}:panel-background", "hidden": False},
            {"id": f"track:{shot_id}:body", "hidden": False},
        ],
    }
    assert _l1_display_ok(project, shot_id) is False
    project["tracks"][1]["hidden"] = True
    assert _l1_display_ok(project, shot_id) is True


async def test_provider_returns_body_and_clean_background_without_a_second_call() -> None:
    encoded, _bounds = _panel()
    provider = GptImageLayerProvider(fetcher=_Fetcher(encoded))
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
    assert [layer.semantic for layer in separation.layers] == ["background", "body"]
    background, body = separation.layers
    assert png_color_type(background.image) == 2
    assert png_color_type(body.image) == 6
    assert body.bounds is not None
    x, y, width, height = body.bounds
    assert width > 1 and height > 1
    assert x >= 0 and y >= 0
    assert x + width <= 108
    assert y + height <= 192
    plate = decode_bgr(background.image)
    assert plate is not None
    assert plate.shape[0] == 192 and plate.shape[1] == 108
    assert float(plate[2, 2, 0]) < float(plate[96, 54, 0])
    assert await provider.reconcile("req-1") is None

    provider._fetcher = _Fetcher(b"not-an-image")
    missing = await provider.separate(
        request_id="req-3",
        shot_id=_SHOT,
        source_url="https://cdn.example/panel.png",
        canvas_width=108,
        canvas_height=192,
        model_version="layer-v1",
        parameter_version="params-v1",
    )
    assert missing.requires_fallback is True
    assert missing.layers == ()


async def test_large_hole_uses_one_inpaint_call_inside_the_mask() -> None:
    encoded, (x0, y0, x1, y1) = _panel()
    filler = _GreenFill((160, 200))
    provider = GptImageLayerProvider(fetcher=_Fetcher(encoded), client=filler)  # type: ignore[arg-type]
    separation = await provider.separate(
        request_id="req-fill",
        shot_id=_SHOT,
        source_url="https://cdn.example/panel.png",
        canvas_width=160,
        canvas_height=200,
        model_version="layer-v1",
        parameter_version="params-v1",
    )
    assert filler.calls == 1
    assert "inpaint-api" in separation.warnings
    background = decode_bgr(separation.layers[0].image)
    assert background is not None
    subject = background[(y0 + y1) // 2, (x0 + x1) // 2]
    assert int(subject[1]) > 200
    assert int(background[4, 4, 1]) < 80
    assert await provider.reconcile("req-fill") is None
