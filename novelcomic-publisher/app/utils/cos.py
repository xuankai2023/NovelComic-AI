"""Tencent COS helpers for browser direct uploads."""

from __future__ import annotations

import asyncio
import secrets
import string
from pathlib import PurePosixPath
from typing import Literal

from app.config import get_settings

DEFAULT_COS_PRESIGN_EXPIRES_IN = 3600
_NANOID_ALPHABET = string.ascii_letters + string.digits + "_-"


def get_cos_cdn_url(object_key: str) -> str:
    settings = get_settings()
    return f"https://{settings.cos_cdn_domain.strip().rstrip('/')}/{object_key}"


def _build_cos_client():
    from qcloud_cos import CosConfig, CosS3Client

    settings = get_settings()
    config = CosConfig(
        Region=settings.cos_region,
        SecretId=settings.cos_secret_id,
        SecretKey=settings.cos_secret_key,
        Scheme="https",
        Domain=settings.cos_accelerate_domain or None,
        Timeout=(5, 60),
    )
    return CosS3Client(config, retry=1)


def generate_cos_presigned_put_url(
    *,
    object_key: str,
    content_type: str,
    expires_in: int = DEFAULT_COS_PRESIGN_EXPIRES_IN,
) -> str:
    settings = get_settings()
    return _build_cos_client().get_presigned_url(
        Bucket=settings.cos_bucket,
        Key=object_key,
        Method="PUT",
        Expired=expires_in,
        Headers={"Content-Type": content_type},
    )


async def a_generate_cos_presigned_put_url(
    *,
    object_key: str,
    content_type: str,
    expires_in: int = DEFAULT_COS_PRESIGN_EXPIRES_IN,
) -> str:
    return await asyncio.to_thread(
        generate_cos_presigned_put_url,
        object_key=object_key,
        content_type=content_type,
        expires_in=expires_in,
    )


def _random_key_part(size: int = 10) -> str:
    return "".join(secrets.choice(_NANOID_ALPHABET) for _ in range(size))


def build_cos_object_key(
    *,
    filename: str,
    file_type: Literal["image", "video", "audio", "file"] | None = None,
) -> str:
    suffix = PurePosixPath(filename).suffix.lower()
    prefix = {
        "image": "images",
        "video": "videos",
        "audio": "audio",
    }.get(file_type or "", "uploads")
    return f"{prefix}/{_random_key_part()}{suffix}"
