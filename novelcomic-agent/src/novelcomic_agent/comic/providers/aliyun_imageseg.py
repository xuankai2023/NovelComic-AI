"""Aliyun VIAPI ImageSeg client for SegmentHDCommonImage."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from io import BytesIO
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "imageseg.cn-shanghai.aliyuncs.com"
_POLL_INTERVAL_SECONDS = 1.5
_POLL_TIMEOUT_SECONDS = 90.0
_SUCCESS = "PROCESS_SUCCESS"
_FAILED = frozenset({"PROCESS_FAILED", "TIMEOUT_FAILED", "LIMIT_RETRY_FAILED"})


class AliyunImageSegError(Exception):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class AliyunImageSegSettings:
    access_key_id: str
    access_key_secret: str
    endpoint: str = _DEFAULT_ENDPOINT

    @classmethod
    def from_env(cls) -> AliyunImageSegSettings | None:
        import os

        key_id = (os.getenv("ALIYUN_VIAPI_ACCESS_KEY_ID") or "").strip()
        secret = (os.getenv("ALIYUN_VIAPI_ACCESS_KEY_SECRET") or "").strip()
        if not key_id or not secret:
            return None
        endpoint = (os.getenv("ALIYUN_IMAGESEG_ENDPOINT") or _DEFAULT_ENDPOINT).strip()
        return cls(
            access_key_id=key_id,
            access_key_secret=secret,
            endpoint=endpoint or _DEFAULT_ENDPOINT,
        )


@dataclass(frozen=True, slots=True)
class AliyunSegmentCutout:
    job_id: str
    image: bytes
    mime_type: str = "image/png"


class AliyunImageSegClient:
    """Submit SegmentHDCommonImage and poll GetAsyncJobResult."""

    def __init__(self, settings: AliyunImageSegSettings) -> None:
        self._settings = settings
        self._http = httpx.AsyncClient(timeout=60.0, follow_redirects=True)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def segment_hd_common_image(self, *, image: bytes) -> AliyunSegmentCutout:
        if not image:
            raise AliyunImageSegError("empty-image", retryable=False)
        job_id = await asyncio.to_thread(self._submit, image)
        result_url = await self._poll_result_url(job_id)
        response = await self._http.get(result_url)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "image/png")
        mime = content_type.split(";", 1)[0].strip() or "image/png"
        return AliyunSegmentCutout(job_id=job_id, image=response.content, mime_type=mime)

    def _create_client(self) -> Any:
        try:
            from alibabacloud_imageseg20191230.client import Client
            from alibabacloud_tea_openapi import models as open_api_models
        except ImportError as exc:
            raise AliyunImageSegError("sdk-missing", retryable=False) from exc

        config = open_api_models.Config(
            access_key_id=self._settings.access_key_id,
            access_key_secret=self._settings.access_key_secret,
        )
        config.endpoint = self._settings.endpoint
        return Client(config)

    def _submit(self, image: bytes) -> str:
        from alibabacloud_imageseg20191230 import models as imageseg_models
        from alibabacloud_tea_util import models as util_models

        client = self._create_client()
        request = imageseg_models.SegmentHDCommonImageAdvanceRequest(
            image_url_object=BytesIO(image),
        )
        response = client.segment_hdcommon_image_advance(
            request,
            util_models.RuntimeOptions(),
        )
        body = getattr(response, "body", None)
        request_id = _attr(body, "request_id", "RequestId")
        if not request_id:
            raise AliyunImageSegError("missing-job-id", retryable=True)
        return str(request_id)

    async def _poll_result_url(self, job_id: str) -> str:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _POLL_TIMEOUT_SECONDS
        while True:
            status, result, error = await asyncio.to_thread(self._query_job, job_id)
            if status == _SUCCESS:
                image_url = _parse_result_image_url(result)
                if not image_url:
                    raise AliyunImageSegError("missing-result-url", retryable=True)
                return image_url
            if status in _FAILED:
                logger.warning(
                    "Aliyun SegmentHDCommonImage failed job=%s status=%s error=%s",
                    job_id,
                    status,
                    error,
                )
                raise AliyunImageSegError(
                    f"segment-failed:{status}",
                    retryable=status == "LIMIT_RETRY_FAILED",
                )
            if loop.time() >= deadline:
                raise AliyunImageSegError("segment-timeout", retryable=True)
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)

    def _query_job(self, job_id: str) -> tuple[str, str | None, str | None]:
        from alibabacloud_imageseg20191230 import models as imageseg_models
        from alibabacloud_tea_util import models as util_models

        client = self._create_client()
        response = client.get_async_job_result_with_options(
            imageseg_models.GetAsyncJobResultRequest(job_id=job_id),
            util_models.RuntimeOptions(),
        )
        body = getattr(response, "body", None)
        data = _attr(body, "data", "Data")
        status = str(_attr(data, "status", "Status") or "")
        result = _attr(data, "result", "Result")
        error = _attr(data, "error_message", "ErrorMessage")
        return status, str(result) if result is not None else None, (
            str(error) if error is not None else None
        )


def _parse_result_image_url(result: str | None) -> str | None:
    if not result:
        return None
    text = result.strip()
    if text.startswith("http://") or text.startswith("https://"):
        return text
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    for key in ("ImageUrl", "imageUrl", "image_url", "Url", "url"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _attr(obj: Any, *keys: str) -> Any:
    if obj is None:
        return None
    for key in keys:
        if isinstance(obj, dict) and key in obj:
            return obj[key]
        if hasattr(obj, key):
            return getattr(obj, key)
    return None
