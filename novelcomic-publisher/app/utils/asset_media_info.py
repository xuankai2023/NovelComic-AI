"""Normalize and probe media metadata for the personal asset library."""

from __future__ import annotations

import asyncio
import math
import struct
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse

import httpx

PROBE_TIMEOUT_SECONDS = 15.0
PROBE_MAX_BYTES = 12 * 1024 * 1024


def _is_positive_int(value: Any) -> bool:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return False
    return number > 0


def normalize_aspect_ratio(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip().replace(":", "/")
    if not text or text.casefold() == "auto":
        return None
    if "/" not in text:
        try:
            number = float(text)
        except ValueError:
            return None
        if not math.isfinite(number) or number <= 0:
            return None
        return text
    left, right = text.split("/", 1)
    if not _is_positive_int(left) or not _is_positive_int(right):
        return None
    return f"{int(left)}/{int(right)}"


def aspect_ratio_from_size(width: int, height: int) -> str:
    gcd = math.gcd(width, height) or 1
    return f"{width // gcd}/{height // gcd}"


def normalize_resource_info(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    info: dict[str, Any] = {}
    if _is_positive_int(value.get("width")):
        info["width"] = int(value["width"])
    if _is_positive_int(value.get("height")):
        info["height"] = int(value["height"])
    format_value = value.get("format")
    if isinstance(format_value, str) and format_value.strip():
        info["format"] = format_value.strip().lower().lstrip(".")
    if _is_positive_int(value.get("file_size")):
        info["file_size"] = int(value["file_size"])
    codec = value.get("codec")
    if isinstance(codec, str) and codec.strip():
        info["codec"] = codec.strip()
    if "width" not in info or "height" not in info:
        return None
    return info


def format_from_url(url: str) -> str | None:
    return PurePosixPath(urlparse(url).path).suffix.lower().lstrip(".") or None


async def _download_prefix(url: str, max_bytes: int = PROBE_MAX_BYTES) -> bytes:
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(PROBE_TIMEOUT_SECONDS),
        follow_redirects=True,
    ) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                if not chunk:
                    continue
                chunks.append(chunk)
                total += len(chunk)
                if total >= max_bytes:
                    break
            return b"".join(chunks)[:max_bytes]


def _parse_png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return (width, height) if width > 0 and height > 0 else None


def _parse_gif_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 10 or data[:6] not in {b"GIF87a", b"GIF89a"}:
        return None
    width, height = struct.unpack("<HH", data[6:10])
    return (width, height) if width > 0 and height > 0 else None


def _parse_jpeg_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        index += 2
        if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
            continue
        if index + 2 > len(data):
            break
        segment_length = struct.unpack(">H", data[index : index + 2])[0]
        if segment_length < 2 or index + segment_length > len(data):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height, width = struct.unpack(">HH", data[index + 3 : index + 7])
            if width > 0 and height > 0:
                return width, height
        index += segment_length
    return None


def _parse_webp_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8X":
        return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
    if chunk == b"VP8 " and data[23] == 0x9D and data[24:27] == b"\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and data[20] == 0x2F:
        bits = struct.unpack("<I", data[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def _parse_image_size(data: bytes) -> tuple[int, int, str] | None:
    for parser, format_name in (
        (_parse_png_size, "png"),
        (_parse_gif_size, "gif"),
        (_parse_jpeg_size, "jpeg"),
        (_parse_webp_size, "webp"),
    ):
        size = parser(data)
        if size:
            return size[0], size[1], format_name
    return None


def _parse_mp4_size(data: bytes) -> tuple[int, int] | None:
    index = 0
    while index + 8 < len(data):
        marker = data.find(b"tkhd", index)
        if marker < 4:
            break
        atom_start = marker - 4
        size = struct.unpack(">I", data[atom_start : atom_start + 4])[0]
        header = 8
        if size == 1:
            if atom_start + 16 > len(data):
                break
            size = struct.unpack(">Q", data[atom_start + 8 : atom_start + 16])[0]
            header = 16
        elif size == 0:
            size = len(data) - atom_start
        if atom_start + size > len(data):
            index = marker + 4
            continue
        body = data[atom_start + header : atom_start + size]
        if len(body) < 84:
            index = marker + 4
            continue
        version = body[0]
        if version == 0:
            width = struct.unpack(">I", body[76:80])[0] / 65536
            height = struct.unpack(">I", body[80:84])[0] / 65536
        elif len(body) >= 96:
            width = struct.unpack(">I", body[88:92])[0] / 65536
            height = struct.unpack(">I", body[92:96])[0] / 65536
        else:
            index = marker + 4
            continue
        rounded = int(round(width)), int(round(height))
        if rounded[0] > 0 and rounded[1] > 0:
            return rounded
        index = marker + 4
    return None


async def _probe_media_resource_info(url: str, media_type: str) -> dict[str, Any] | None:
    max_bytes = (
        max(PROBE_MAX_BYTES, 32 * 1024 * 1024)
        if media_type == "video"
        else PROBE_MAX_BYTES
    )
    try:
        data = await _download_prefix(url, max_bytes=max_bytes)
    except Exception:
        return None

    if media_type == "image":
        parsed = await asyncio.to_thread(_parse_image_size, data)
        if not parsed:
            return None
        width, height, format_name = parsed
        return {"width": width, "height": height, "format": format_name, "file_size": len(data)}

    if media_type == "video":
        parsed = _parse_mp4_size(data)
        if not parsed:
            return None
        info: dict[str, Any] = {"width": parsed[0], "height": parsed[1], "file_size": len(data)}
        format_value = format_from_url(url)
        if format_value:
            info["format"] = format_value
        return info

    return None


async def resolve_media_dimensions(
    *,
    url: str,
    media_type: str,
    resource_info: Any = None,
    aspect_ratio: Any = None,
) -> dict[str, Any]:
    normalized_info = normalize_resource_info(resource_info)
    normalized_ratio = normalize_aspect_ratio(aspect_ratio)

    if normalized_info is None:
        normalized_info = await _probe_media_resource_info(url, media_type)

    if normalized_info is not None and normalized_ratio is None:
        normalized_ratio = aspect_ratio_from_size(
            int(normalized_info["width"]),
            int(normalized_info["height"]),
        )

    result: dict[str, Any] = {}
    if normalized_info is not None:
        normalized_info.setdefault("format", format_from_url(url))
        result["resource_info"] = {
            key: value for key, value in normalized_info.items() if value is not None
        }
    if normalized_ratio is not None:
        result["aspect_ratio"] = normalized_ratio
    return result
