"""GPT Image 2 through the Baidu then Tencent route OpenCreator already runs.

Model ids match the OpenCreator registry:

- ``opencreator/text-to-image/gpt-image-2``
- ``opencreator/image-to-image/gpt-image-2-edit``
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

TEXT_MODEL_ID = "opencreator/text-to-image/gpt-image-2"
EDIT_MODEL_ID = "opencreator/image-to-image/gpt-image-2-edit"
BAIDU_PROVIDER_MODEL = "gpt-image-2"
TENCENT_TEXT_MODEL = "custom-textmodel-gt"
TENCENT_IMAGE_MODEL = "custom-imagemodel-gt"
DEFAULT_BAIDU_BASE_URL = "https://vod.bj.baidubce.com"
DEFAULT_TENCENT_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com"
_RETRYABLE_STATUS = {408, 429, 500, 502, 503}


class GptImage2Error(Exception):
    def __init__(self, message: str, *, provider: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class GptImage2Image:
    model_id: str
    provider: str
    provider_request_id: str
    image: bytes
    mime_type: str


@dataclass(frozen=True, slots=True)
class GptImage2Settings:
    baidu_api_key: str = ""
    baidu_base_url: str = DEFAULT_BAIDU_BASE_URL
    tencent_api_key: str = ""
    tencent_base_url: str = DEFAULT_TENCENT_BASE_URL

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> GptImage2Settings:
        source = os.environ if environ is None else environ
        return cls(
            baidu_api_key=source.get("BAIDU_API_KEY", "").strip(),
            baidu_base_url=source.get("BAIDU_BASE_URL", DEFAULT_BAIDU_BASE_URL).strip()
            or DEFAULT_BAIDU_BASE_URL,
            tencent_api_key=source.get("TENCENT_API_KEY", "").strip(),
            tencent_base_url=source.get("TENCENT_MAAS_BASE_URL", DEFAULT_TENCENT_BASE_URL).strip()
            or DEFAULT_TENCENT_BASE_URL,
        )


class GptImage2Client:
    """Submit one GPT Image 2 task. A failed provider is replaced by the next one."""

    def __init__(
        self,
        settings: GptImage2Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 180.0,
    ) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(transport=transport, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def generate(
        self,
        *,
        prompt: str,
        quality: str = "medium",
        size: str | None = None,
        aspect_ratio: str | None = None,
    ) -> GptImage2Image:
        return await self._run(
            model_id=TEXT_MODEL_ID,
            prompt=prompt,
            quality=quality,
            size=size,
            aspect_ratio=aspect_ratio,
            image=None,
            image_url=None,
        )

    async def edit(
        self,
        *,
        prompt: str,
        image: bytes | None = None,
        image_url: str | None = None,
        quality: str = "medium",
        size: str | None = None,
        aspect_ratio: str | None = None,
    ) -> GptImage2Image:
        if image is None and not image_url:
            raise GptImage2Error("image or image_url is required", provider="gpt-image-2")
        return await self._run(
            model_id=EDIT_MODEL_ID,
            prompt=prompt,
            quality=quality,
            size=size,
            aspect_ratio=aspect_ratio,
            image=image,
            image_url=image_url,
        )

    async def _run(
        self,
        *,
        model_id: str,
        prompt: str,
        quality: str,
        size: str | None,
        aspect_ratio: str | None,
        image: bytes | None,
        image_url: str | None,
    ) -> GptImage2Image:
        if not prompt.strip():
            raise GptImage2Error("prompt is required", provider="gpt-image-2")
        errors: list[GptImage2Error] = []
        if self._settings.baidu_api_key:
            try:
                return await self._baidu(
                    model_id=model_id,
                    prompt=prompt,
                    quality=quality,
                    size=size,
                    aspect_ratio=aspect_ratio,
                    image=image,
                    image_url=image_url,
                )
            except GptImage2Error as exc:
                errors.append(exc)
        if self._settings.tencent_api_key:
            try:
                return await self._tencent(
                    model_id=model_id,
                    prompt=prompt,
                    quality=quality,
                    size=size,
                    aspect_ratio=aspect_ratio,
                    image_url=image_url,
                )
            except GptImage2Error as exc:
                errors.append(exc)
        if errors:
            raise errors[-1]
        raise GptImage2Error(
            "BAIDU_API_KEY or TENCENT_API_KEY is required",
            provider="gpt-image-2",
        )

    async def _baidu(
        self,
        *,
        model_id: str,
        prompt: str,
        quality: str,
        size: str | None,
        aspect_ratio: str | None,
        image: bytes | None,
        image_url: str | None,
    ) -> GptImage2Image:
        editing = model_id == EDIT_MODEL_ID
        path = "/v3/aigc/v1/images/edits" if editing else "/v3/aigc/v1/images/generations"
        url = f"{self._settings.baidu_base_url.rstrip('/')}{path}"
        body = {
            "model": BAIDU_PROVIDER_MODEL,
            "prompt": prompt.strip(),
            "n": 1,
            "size": baidu_size(size, aspect_ratio),
            "quality": normalize_quality(quality),
        }
        headers = {"Authorization": f"Bearer {self._settings.baidu_api_key}"}
        if editing:
            image_bytes = image if image is not None else await self._download(image_url or "")
            response = await self._client.post(
                url,
                headers=headers,
                data={key: str(value) for key, value in body.items()},
                files=[("image[]", ("image-1.png", image_bytes, "image/png"))],
            )
        else:
            response = await self._client.post(url, headers=headers, json=body)
        payload = await self._json(response, provider="baidu")
        encoded = _first_b64(payload)
        if not encoded:
            raise GptImage2Error(
                "No base64 image data in Baidu GPT Image response",
                provider="baidu",
                retryable=True,
            )
        return GptImage2Image(
            model_id=model_id,
            provider="baidu",
            provider_request_id=f"baidu-gpt-image-{response.headers.get('x-request-id', 'local')}",
            image=base64.b64decode(encoded),
            mime_type="image/png",
        )

    async def _tencent(
        self,
        *,
        model_id: str,
        prompt: str,
        quality: str,
        size: str | None,
        aspect_ratio: str | None,
        image_url: str | None,
    ) -> GptImage2Image:
        editing = model_id == EDIT_MODEL_ID
        if editing and not image_url:
            raise GptImage2Error("Tencent GPT Image edit requires image_url", provider="tencent")
        path = "/v1/aiart/gtimage" if editing else "/v1/aiart/gttext"
        url = f"{self._settings.tencent_base_url.rstrip('/')}{path}"
        provider_model = TENCENT_IMAGE_MODEL if editing else TENCENT_TEXT_MODEL
        body: dict[str, Any] = {
            "model": provider_model,
            "prompt": prompt.strip(),
            "n": 1,
            "quality": normalize_quality(quality),
        }
        resolved_size = tencent_size(size, aspect_ratio)
        if resolved_size:
            body["size"] = resolved_size
        if editing:
            body["images"] = [{"image_url": image_url}]
        response = await self._client.post(
            url,
            headers={
                "Authorization": f"Bearer {self._settings.tencent_api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        payload = await self._json(response, provider="tencent")
        image_urls = _tencent_urls(payload)
        if not image_urls:
            message = _tencent_error(payload) or "No image URL in Tencent GPT Image response"
            raise GptImage2Error(message, provider="tencent", retryable=True)
        downloaded = await self._download(image_urls[0])
        request_id = str(
            payload.get("request_id") or payload.get("requestId") or "tencent-gpt-image"
        )
        return GptImage2Image(
            model_id=model_id,
            provider="tencent",
            provider_request_id=request_id,
            image=downloaded,
            mime_type="image/png",
        )

    async def _download(self, url: str) -> bytes:
        response = await self._client.get(url)
        if response.status_code >= 400:
            raise GptImage2Error(
                f"Failed to download image: {response.status_code}",
                provider="gpt-image-2",
                retryable=response.status_code in _RETRYABLE_STATUS,
            )
        return response.content

    async def _json(self, response: httpx.Response, *, provider: str) -> dict[str, Any]:
        if response.status_code >= 400:
            raise GptImage2Error(
                f"{provider} GPT Image API error ({response.status_code})",
                provider=provider,
                retryable=response.status_code in _RETRYABLE_STATUS,
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise GptImage2Error(
                f"{provider} GPT Image returned a non-object body",
                provider=provider,
            )
        return payload


def normalize_quality(quality: str) -> str:
    return quality if quality in {"low", "medium", "high"} else "medium"


def baidu_size(size: str | None, aspect_ratio: str | None) -> str:
    mapped = {
        "1024x1024": "1024x1024",
        "1024x1536": "1024x1536",
        "1536x1024": "1536x1024",
        "2560x1440": "2560x1440",
        "portrait_4_3": "1024x1536",
        "portrait_16_9": "1024x1536",
        "landscape_4_3": "1536x1024",
        "landscape_16_9": "1536x1024",
        "square": "1024x1024",
        "square_hd": "1024x1024",
    }
    if size in mapped:
        return mapped[size]
    if aspect_ratio in {"9:16", "3:4"}:
        return "1024x1536"
    if aspect_ratio == "1:1":
        return "1024x1024"
    return "1536x1024"


def tencent_size(size: str | None, aspect_ratio: str | None) -> str | None:
    mapped = {
        "1024x1024": "1024x1024",
        "1024x1536": "1024x1536",
        "1536x1024": "1536x1024",
        "auto": "auto",
        "portrait_4_3": "1024x1536",
        "portrait_16_9": "1024x1536",
        "landscape_4_3": "1536x1024",
        "landscape_16_9": "1536x1024",
        "square": "1024x1024",
        "square_hd": "1024x1024",
    }
    if size in mapped:
        return mapped[size]
    if aspect_ratio in {"9:16", "3:4"}:
        return "1024x1536"
    if aspect_ratio in {"16:9", "4:3"}:
        return "1536x1024"
    if aspect_ratio == "1:1":
        return "1024x1024"
    return None


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _first_b64(payload: dict[str, Any]) -> str:
    data = payload.get("data")
    if not isinstance(data, list):
        return ""
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("b64_json"), str) and item["b64_json"]:
            return item["b64_json"]
    return ""


def _tencent_urls(payload: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for key in ("data", "result_image", "resultImage"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("Url")
            if isinstance(url, str) and url:
                urls.append(url)
    return list(dict.fromkeys(urls))


def _tencent_error(payload: dict[str, Any]) -> str:
    status = str(payload.get("status") or "")
    code = payload.get("error_code") or payload.get("errorCode")
    message = payload.get("error_message") or payload.get("errorMessage")
    if str(status).lower() == "failed" or code or message:
        return str(message or code or "Tencent GPT Image failed")
    return ""


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Call GPT Image 2 and write one PNG.")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image-url")
    parser.add_argument("--image-file")
    parser.add_argument("--output", required=True)
    parser.add_argument("--quality", default="low", choices=("low", "medium", "high"))
    parser.add_argument("--aspect-ratio", default="9:16")
    parser.add_argument("--env-file")
    return parser.parse_args()


async def _call(args: argparse.Namespace, environ: dict[str, str]) -> GptImage2Image:
    client = GptImage2Client(GptImage2Settings.from_env(environ))
    try:
        if args.image_url or args.image_file:
            return await client.edit(
                prompt=args.prompt,
                image=args.image_bytes,
                image_url=args.image_url,
                quality=args.quality,
                aspect_ratio=args.aspect_ratio,
            )
        return await client.generate(
            prompt=args.prompt,
            quality=args.quality,
            aspect_ratio=args.aspect_ratio,
        )
    finally:
        await client.aclose()


def _main() -> None:
    args = _parse_args()
    args.image_bytes = Path(args.image_file).read_bytes() if args.image_file else None
    environ = dict(os.environ)
    if args.env_file:
        environ.update(load_env_file(Path(args.env_file)))
    result = asyncio.run(_call(args, environ))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result.image)
    print(f"provider={result.provider}")
    print(f"model={result.model_id}")
    print(f"bytes={len(result.image)}")
    print(f"output={output}")


if __name__ == "__main__":
    _main()
