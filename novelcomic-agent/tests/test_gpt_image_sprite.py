"""GptImageSpriteProvider uses the OpenCreator GPT Image 2 edit client."""

from __future__ import annotations

import base64

import httpx
import pytest

from novelcomic_agent.comic.assets.l2_sprite_service import SpriteProviderError
from novelcomic_agent.comic.providers.gpt_image_2 import GptImage2Client, GptImage2Settings
from novelcomic_agent.comic.providers.gpt_image_sprite import GptImageSpriteProvider
from novelcomic_agent.config import Settings


def _png_b64() -> str:
    # Minimal 1x1 PNG.
    raw = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00"
        b"\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return base64.b64encode(raw).decode("ascii")


@pytest.mark.asyncio
async def test_sprite_provider_edits_required_states() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": _png_b64()}]},
            headers={"x-request-id": "baidu-1"},
        )

    transport = httpx.MockTransport(handler)
    client = GptImage2Client(
        GptImage2Settings(baidu_api_key="baidu-key"),
        transport=transport,
    )
    provider = GptImageSpriteProvider(client=client, unit_price_fen=2)
    result = await provider.generate(
        request_id="req-1",
        shot_id="shot-1",
        source_url="https://cdn.example/face.png",
        canvas_width=1080,
        canvas_height=1920,
        model_version="sprite-v1",
        parameter_version="params-v1",
        required_states=("eye:open", "eye:closed"),
    )
    assert result.provider_request_id == "req-1"
    assert result.cost_fen == 4
    assert result.missing == ()
    assert {f"{s.part}:{s.semantic}" for s in result.states} == {"eye:open", "eye:closed"}
    assert any("/images/edits" in path for path in calls)
    assert calls.count("/v3/aigc/v1/images/edits") == 2
    assert await provider.reconcile("req-1") is result
    await provider.aclose()


@pytest.mark.asyncio
async def test_sprite_provider_records_missing_on_provider_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(500, json={"error": {"message": "boom"}})

    transport = httpx.MockTransport(handler)
    client = GptImage2Client(
        GptImage2Settings(baidu_api_key="baidu-key", tencent_api_key=""),
        transport=transport,
    )
    provider = GptImageSpriteProvider(client=client)
    with pytest.raises(SpriteProviderError):
        await provider.generate(
            request_id="req-2",
            shot_id="shot-1",
            source_url="https://cdn.example/face.png",
            canvas_width=1080,
            canvas_height=1920,
            model_version="sprite-v1",
            parameter_version="params-v1",
            required_states=("mouth:open",),
        )
    await provider.aclose()


def test_from_settings_requires_opencreator_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    from novelcomic_agent.comic.providers import gpt_image_sprite as mod

    class Empty:
        baidu_api_key = ""
        tencent_api_key = ""

    monkeypatch.setattr(mod.GptImage2Settings, "from_env", classmethod(lambda cls, environ=None: Empty()))
    assert GptImageSpriteProvider.from_settings(Settings()) is None
