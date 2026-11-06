import json
import logging
from typing import Any

import httpx

from app.middleware.auth_middleware import AuthUser
from app.social.poster.base_poster import BasePoster
from app.social.provider.__base.redis_keys import YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX

log = logging.getLogger(__name__)

POST_VIDEO_URL = "https://www.googleapis.com/upload/youtube/v3/videos"


class YouTubePoster(BasePoster):
    async def a_post(self, **kwargs) -> None:
        redis_client = kwargs["redis_client"]
        user: AuthUser = kwargs["user"]
        video_url = str(kwargs.get("video_url") or "").strip()
        title = str(kwargs.get("title") or "Untitled")
        description = str(kwargs.get("description") or "")
        if not video_url:
            raise ValueError("video_url is required for YouTube posting")

        access_token = await _get_access_token(
            redis_client,
            YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX + user.user_id,
        )
        video_data = await _download_video(video_url)
        init_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/*",
            "X-Upload-Content-Length": str(len(video_data)),
        }
        body = {
            "snippet": {
                "title": title,
                "description": description,
                "categoryId": "22",
            },
            "status": {"privacyStatus": "private"},
        }
        params = {"uploadType": "resumable", "part": "snippet,status"}
        async with httpx.AsyncClient(timeout=120) as client:
            init_response = await client.post(
                POST_VIDEO_URL,
                params=params,
                headers=init_headers,
                content=json.dumps(body),
            )
            init_response.raise_for_status()
            upload_url = init_response.headers.get("Location")
            if not upload_url:
                raise RuntimeError("No upload URL returned from YouTube")

            upload_response = await client.put(
                upload_url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Length": str(len(video_data)),
                    "Content-Type": "video/*",
                },
                content=video_data,
            )
            upload_response.raise_for_status()
        log.info("YouTube video uploaded for user_id=%s", user.user_id)


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


youtube_poster = YouTubePoster()
