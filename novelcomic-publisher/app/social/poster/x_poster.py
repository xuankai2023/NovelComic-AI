import logging
from typing import Any

import httpx

from app.middleware.auth_middleware import AuthUser
from app.social.poster.base_poster import BasePoster
from app.social.provider.__base.redis_keys import X_ACCESS_TOKEN_REDIS_KEY_PREFIX

log = logging.getLogger(__name__)

POST_CREATION_URL = "https://api.twitter.com/2/tweets"
INIT_MEDIA_UPLOAD_URL = "https://api.twitter.com/2/media/upload/initialize"
RESUMABLE_UPLOAD_APPEND_URL = "https://api.twitter.com/2/media/upload/{id}/append"
FINALIZE_MEDIA_UPLOAD_URL = "https://api.twitter.com/2/media/upload/{id}/finalize"
SEGMENT_SIZE = 2 * 1024 * 1024


class XPoster(BasePoster):
    async def a_post(self, **kwargs) -> None:
        redis_client = kwargs["redis_client"]
        user: AuthUser = kwargs["user"]
        video_url = str(kwargs.get("video_url") or "").strip()
        text = str(kwargs.get("text") or "Check out this video!")
        if not video_url:
            raise ValueError("video_url is required for X posting")

        access_token = await _get_access_token(
            redis_client,
            X_ACCESS_TOKEN_REDIS_KEY_PREFIX + user.user_id,
        )
        video_data = await _download_video(video_url)
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        media_id = await self._upload_video(video_data=video_data, headers=headers)
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                POST_CREATION_URL,
                headers=headers,
                json={"text": text, "media": {"media_ids": [media_id]}},
            )
        response.raise_for_status()
        log.info("X tweet created for user_id=%s", user.user_id)

    async def _upload_video(self, *, video_data: bytes, headers: dict[str, str]) -> str:
        async with httpx.AsyncClient(timeout=120) as client:
            init_response = await client.post(
                INIT_MEDIA_UPLOAD_URL,
                headers=headers,
                json={
                    "media_type": "video/mp4",
                    "total_bytes": len(video_data),
                    "media_category": "tweet_video",
                },
            )
            init_response.raise_for_status()
            media_id = init_response.json().get("data", {}).get("id")
            if not media_id:
                raise RuntimeError("No media id returned from X")

            for segment_index, offset in enumerate(range(0, len(video_data), SEGMENT_SIZE)):
                chunk = video_data[offset : offset + SEGMENT_SIZE]
                append_response = await client.post(
                    RESUMABLE_UPLOAD_APPEND_URL.format(id=media_id),
                    headers={"Authorization": headers["Authorization"]},
                    files={
                        "media": ("segment.mp4", chunk, "video/mp4"),
                        "segment_index": (None, str(segment_index)),
                    },
                )
                append_response.raise_for_status()

            finalize_response = await client.post(
                FINALIZE_MEDIA_UPLOAD_URL.format(id=media_id),
                headers=headers,
            )
            finalize_response.raise_for_status()
            return str(media_id)


async def _download_video(video_url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        response = await client.get(video_url)
    response.raise_for_status()
    return response.content


async def _get_access_token(redis_client: Any, key: str) -> str:
    token = await redis_client.get(key)
    if not token:
        raise ValueError("Access token not found in Redis")
    if isinstance(token, bytes):
        return token.decode()
    return str(token)


x_poster = XPoster()
