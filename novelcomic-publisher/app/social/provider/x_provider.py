import base64
import logging
from typing import Any

import httpx

from app.config import get_settings
from app.social.provider.base_provider import BaseProvider

log = logging.getLogger(__name__)

_PKCE_PLACEHOLDER = "challenge"


class XAuthProvider(BaseProvider):
    def __init__(self, client_id: str, client_secret: str) -> None:
        super().__init__(client_id, client_secret)
        self.base_auth_url = "https://x.com/i/oauth2/authorize"
        self.token_url = "https://api.x.com/2/oauth2/token"
        self.scope = [
            "tweet.read",
            "tweet.write",
            "users.read",
            "media.write",
            "offline.access",
        ]

    async def gen_auth_url(self, redirect_uri: str, state: str) -> str:
        auth_params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scope),
            "state": state,
            "code_challenge": _PKCE_PLACEHOLDER,
            "code_challenge_method": "plain",
        }
        auth_url = BaseProvider.build_url(self.base_auth_url, auth_params)
        log.info("Generated X auth URL with placeholder PKCE challenge")
        return auth_url

    async def get_token(self, code: str, redirect_uri: str) -> dict[str, Any]:
        token_data = {
            "client_id": self.client_id,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
            "code_verifier": _PKCE_PLACEHOLDER,
        }
        token_info = await self._post_token(token_data)
        return {
            "access_token": token_info["access_token"],
            "refresh_token": token_info["refresh_token"],
        }

    async def refresh_token(self, refresh_token: str) -> dict[str, Any]:
        token_data = {
            "client_id": self.client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
        token_info = await self._post_token(token_data)
        return {
            "access_token": token_info["access_token"],
            "refresh_token": token_info.get("refresh_token", refresh_token),
        }

    async def _post_token(self, data: dict[str, str]) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "Authorization": f"Basic {self._basic_auth()}",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(self.token_url, data=data, headers=headers)
        response.raise_for_status()
        token_info = response.json()
        if not isinstance(token_info, dict):
            raise RuntimeError("X token endpoint returned an unexpected payload")
        return token_info

    def _basic_auth(self) -> str:
        credentials = f"{self.client_id}:{self.client_secret}".encode()
        return base64.b64encode(credentials).decode("utf-8")


settings = get_settings()
x_auth_provider = XAuthProvider(
    client_id=settings.x_client_id,
    client_secret=settings.x_client_secret,
)
