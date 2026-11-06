"""Publisher-side image segmentation via Aliyun SegmentCommonImage."""

from __future__ import annotations

import asyncio
import secrets
import string
from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from io import BytesIO
from typing import Any

import httpx

from app.config import get_settings
from app.schemas.image_segmentation import SegmentCommonImageRequest, SegmentCommonImageResponse
from app.utils.cos import get_cos_cdn_url

ALIYUN_SEGMENT_COMMON_IMAGE_RMB_PER_CALL = "0.0016"
RMB_PER_USD = Decimal("6.7")
NOVELCOMIC_CREDITS_PER_USD = Decimal("1000")
_NANOID_ALPHABET = string.ascii_letters + string.digits + "_-"


class ImageSegmentationServiceError(Exception):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class AliyunSegmentResult:
    image_url: str
    request_id: str | None = None


class ImageSegmentationService:
    PROVIDER = "aliyun"
    DEFAULT_OBJECT_KEY_PREFIX = "images/segmentation"

    @classmethod
    async def segment_common_image(
        cls,
        *,
        user_id: str,
        request: SegmentCommonImageRequest,
    ) -> SegmentCommonImageResponse:
        del user_id
        credits = cls._get_credits_per_call()
        cls._ensure_sufficient_credits_if_configured(credits=credits)

        source_image_url = str(request.image_url)
        aliyun_result = await cls._call_aliyun_segment_common_image(
            image_url=source_image_url,
            return_form=request.return_form,
        )
        result_url, object_key = await cls._persist_aliyun_result(
            result_url=aliyun_result.image_url,
        )
        cls._charge_credits_if_configured(credits=credits)

        return SegmentCommonImageResponse(
            source_image_url=source_image_url,
            result_url=result_url,
            object_key=object_key,
            return_form=request.return_form,
            provider=cls.PROVIDER,
            provider_request_id=aliyun_result.request_id,
            credits_charged=credits,
        )

    @classmethod
    def _get_credits_per_call(cls) -> int:
        usd_price = Decimal(ALIYUN_SEGMENT_COMMON_IMAGE_RMB_PER_CALL) / RMB_PER_USD
        credits = int(
            (usd_price * NOVELCOMIC_CREDITS_PER_USD).to_integral_value(
                rounding=ROUND_CEILING,
            )
        )
        return max(credits, 1)

    @classmethod
    def _ensure_sufficient_credits_if_configured(cls, *, credits: int) -> None:
        balance = get_settings().image_segmentation_credit_balance
        if balance is not None and balance < credits:
            raise ImageSegmentationServiceError("Insufficient credits", status_code=402)

    @classmethod
    def _charge_credits_if_configured(cls, *, credits: int) -> None:
        del credits
        # NovelComic does not have the unified credits ledger yet. The configured
        # balance gate still keeps provider calls from happening when tests or
        # deployments explicitly mark the balance as insufficient.

    @classmethod
    async def _call_aliyun_segment_common_image(
        cls,
        *,
        image_url: str,
        return_form: str | None,
    ) -> AliyunSegmentResult:
        client = cls._create_aliyun_client()

        try:
            from alibabacloud_imageseg20191230 import models as imageseg_models
            from alibabacloud_tea_util import models as util_models
        except ImportError as exc:
            raise ImageSegmentationServiceError(
                "Aliyun image segmentation SDK is not installed",
                status_code=500,
            ) from exc

        source_image_file = await cls._download_source_image_as_file(image_url)
        response = await asyncio.to_thread(
            client.segment_common_image_advance,
            imageseg_models.SegmentCommonImageAdvanceRequest(
                image_urlobject=source_image_file,
                return_form=return_form,
            ),
            util_models.RuntimeOptions(),
        )
        body = cls._get_value(response, "body")
        data = cls._get_value(body, "data", "Data")
        result_image_url = cls._get_value(data, "image_url", "ImageURL")
        if not result_image_url:
            raise ImageSegmentationServiceError(
                "Aliyun SegmentCommonImage response missing Data.ImageURL",
                status_code=502,
            )
        return AliyunSegmentResult(
            image_url=result_image_url,
            request_id=cls._get_value(body, "request_id", "RequestId"),
        )

    @staticmethod
    async def _download_source_image_as_file(image_url: str) -> BytesIO:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(image_url)
            response.raise_for_status()
        return BytesIO(response.content)

    @staticmethod
    def _create_aliyun_client() -> Any:
        settings = get_settings()
        access_key_id = settings.aliyun_viapi_access_key_id
        access_key_secret = settings.aliyun_viapi_access_key_secret
        if not access_key_id or not access_key_secret:
            raise ImageSegmentationServiceError(
                "Aliyun VIAPI access key is not configured",
                status_code=500,
            )

        try:
            from alibabacloud_imageseg20191230.client import Client
            from alibabacloud_tea_openapi import models as open_api_models
        except ImportError as exc:
            raise ImageSegmentationServiceError(
                "Aliyun image segmentation SDK is not installed",
                status_code=500,
            ) from exc

        config = open_api_models.Config(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
        )
        config.endpoint = settings.aliyun_imageseg_endpoint
        return Client(config)

    @classmethod
    async def _persist_aliyun_result(cls, *, result_url: str) -> tuple[str, str]:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(result_url)
            response.raise_for_status()
        object_key = f"{cls.DEFAULT_OBJECT_KEY_PREFIX}/{cls._random_key_part(24)}.png"
        await cls._upload_result_to_cos(
            object_key=object_key,
            content=response.content,
            content_type=response.headers.get("content-type") or "image/png",
        )
        return get_cos_cdn_url(object_key), object_key

    @staticmethod
    async def _upload_result_to_cos(
        *,
        object_key: str,
        content: bytes,
        content_type: str,
    ) -> None:
        def upload() -> None:
            from qcloud_cos import CosConfig, CosS3Client

            settings = get_settings()
            config = CosConfig(
                Region=settings.cos_region,
                SecretId=settings.cos_secret_id,
                SecretKey=settings.cos_secret_key,
                Scheme="https",
                Domain=settings.cos_accelerate_domain or None,
            )
            client = CosS3Client(config, retry=1)
            client.put_object(
                Bucket=settings.cos_bucket,
                Key=object_key,
                Body=content,
                ContentType=content_type,
            )

        await asyncio.to_thread(upload)

    @staticmethod
    def _random_key_part(size: int) -> str:
        return "".join(secrets.choice(_NANOID_ALPHABET) for _ in range(size))

    @staticmethod
    def _get_value(obj: Any, *keys: str) -> Any:
        if obj is None:
            return None
        for key in keys:
            if isinstance(obj, dict) and key in obj:
                return obj[key]
            if hasattr(obj, key):
                return getattr(obj, key)
        return None
