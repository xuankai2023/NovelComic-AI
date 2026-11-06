import logging
from typing import Any

import httpx

from app.middleware.auth_middleware import AuthUser
from app.social.poster.base_poster import BasePoster
from app.social.provider.__base.redis_keys import TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX

log = logging.getLogger(__name__)

POST_VIDEO_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/"


class TikTokPoster(BasePoster):
    async def a_post(self, **kwargs) -> None:
        redis_client = kwargs["redis_client"]
        user: AuthUser = kwargs["user"]
        video_url = str(kwargs.get("video_url") or "").strip()
        title = str(kwargs.get("title") or "Untitled")
        if not video_url:
            raise ValueError("video_url is required for TikTok posting")

        access_token = await _get_access_token(
            redis_client,
            TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX + user.user_id,
        )
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        payload = {
            "post_info": {
                "title": title,
                "privacy_level": "SELF_ONLY",
                "disable_duet": False,
                "disable_comment": True,
                "disable_stitch": False,
                "video_cover_timestamp_ms": 1000,
            },
            "source_info": {
                "source": "PULL_FROM_URL",
                "video_url": video_url,
            },
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(POST_VIDEO_URL, headers=headers, json=payload)
        response.raise_for_status()
        log.info("TikTok post initialized for user_id=%s", user.user_id)


async def _get_access_token(redis_client: Any, key: str) -> str:
    token = await redis_client.get(key)
    if not token:
        raise ValueError("Access token not found in Redis")
    if isinstance(token, bytes):
        return token.decode()
    return str(token)


tiktok_poster = TikTokPoster()
