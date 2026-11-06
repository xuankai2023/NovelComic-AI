"""GPT Image 2 uses the OpenCreator Baidu then Tencent route."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from novelcomic_agent.comic.providers.gpt_image_2 import (
    EDIT_MODEL_ID,
    TEXT_MODEL_ID,
    GptImage2Client,
    GptImage2Error,
    GptImage2Settings,
)

_PNG = base64.b64encode(b"png-bytes").decode()


def _client(handler, **settings: str) -> GptImage2Client:
    return GptImage2Client(
        GptImage2Settings(
            baidu_api_key=settings.get("baidu_api_key", "baidu-key"),
            baidu_base_url="https://baidu.test",
            tencent_api_key=settings.get("tencent_api_key", "tencent-key"),
            tencent_base_url="https://tencent.test",
        ),
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_text_generation_uses_baidu_gpt_image_2() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": _PNG}]})

    client = _client(handler)
    result = await client.generate(prompt="a comic panel", quality="low", aspect_ratio="9:16")
    await client.aclose()

    assert result.model_id == TEXT_MODEL_ID
    assert result.provider == "baidu"
    assert result.image == b"png-bytes"
    assert seen[0].url.path == "/v3/aigc/v1/images/generations"
    assert seen[0].headers["authorization"] == "Bearer baidu-key"
    assert json.loads(seen[0].content) == {
        "model": "gpt-image-2",
        "prompt": "a comic panel",
        "n": 1,
        "size": "1024x1536",
        "quality": "low",
    }


@pytest.mark.asyncio
async def test_edit_posts_the_source_image_to_baidu() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v3/aigc/v1/images/edits"
        assert b"image[]" in request.read()
        return httpx.Response(200, json={"data": [{"b64_json": _PNG}]})

    client = _client(handler)
    result = await client.edit(prompt="close the eyes", image=b"source", quality="low")
    await client.aclose()
    assert result.model_id == EDIT_MODEL_ID
    assert result.provider == "baidu"


@pytest.mark.asyncio
async def test_baidu_failure_falls_through_to_tencent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "baidu.test":
            return httpx.Response(503, text="busy")
        assert request.url.path == "/v1/aiart/gttext"
        body = request.read()
        assert b"custom-textmodel-gt" in body
        return httpx.Response(
            200,
            json={"request_id": "tx-1", "data": [{"url": "https://cdn.test/out.png"}]},
        )

    downloads = {"https://cdn.test/out.png": b"tencent-png"}

    def routed(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, content=downloads[str(request.url)])
        return handler(request)

    client = _client(routed)
    result = await client.generate(prompt="a comic panel", quality="low")
    await client.aclose()
    assert result.provider == "tencent"
    assert result.provider_request_id == "tx-1"
    assert result.image == b"tencent-png"


@pytest.mark.asyncio
async def test_missing_keys_fail_before_a_request() -> None:
    client = _client(lambda request: httpx.Response(500), baidu_api_key="", tencent_api_key="")
    with pytest.raises(GptImage2Error, match="BAIDU_API_KEY or TENCENT_API_KEY"):
        await client.generate(prompt="a comic panel")
    await client.aclose()
