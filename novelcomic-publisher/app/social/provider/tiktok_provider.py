import logging
from typing import Any

import httpx

from app.config import get_settings
from app.social.provider.base_provider import BaseProvider

log = logging.getLogger(__name__)


class TikTokAuthProvider(BaseProvider):
    def __init__(self, client_id: str, client_secret: str) -> None:
        super().__init__(client_id, client_secret)
        self.base_auth_url = "https://www.tiktok.com/v2/auth/authorize/"
        self.token_url = "https://open.tiktokapis.com/v2/oauth/token/"
        self.scope = ["user.info.basic", "video.publish", "video.upload", "user.info.profile"]

    async def gen_auth_url(self, redirect_uri: str, state: str) -> str:
        auth_params = {
            "client_key": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": ",".join(self.scope),
            "state": state,
        }
        auth_url = BaseProvider.build_url(self.base_auth_url, auth_params)
        log.info("Generated TikTok auth URL")
        return auth_url

    async def get_token(self, code: str, redirect_uri: str) -> dict[str, Any]:
        token_data = {
            "client_key": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
        token_info = await self._post_token(token_data)
        return {
            "access_token": token_info["access_token"],
            "refresh_token": token_info["refresh_token"],
        }

    async def refresh_token(self, refresh_token: str) -> dict[str, Any]:
        token_data = {
            "client_key": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
        token_info = await self._post_token(token_data)
        return {
            "access_token": token_info["access_token"],
            "refresh_token": token_info["refresh_token"],
        }

    async def _post_token(self, data: dict[str, str]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(self.token_url, data=data)
        response.raise_for_status()
        token_info = response.json()
        if not isinstance(token_info, dict):
            raise RuntimeError("TikTok token endpoint returned an unexpected payload")
        return token_info


settings = get_settings()
tiktok_provider = TikTokAuthProvider(
    client_id=settings.tiktok_client_key,
    client_secret=settings.tiktok_client_secret,
)
