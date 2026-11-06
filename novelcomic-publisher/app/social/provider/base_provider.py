from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode


class BaseProvider(ABC):
    """Base OAuth provider contract for social publishing integrations."""

    def __init__(self, client_id: str, client_secret: str) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.base_auth_url = ""
        self.token_url = ""
        self.scope: list[str] = []

    @abstractmethod
    async def gen_auth_url(self, redirect_uri: str, state: str) -> str:
        pass

    @abstractmethod
    async def get_token(self, code: str, redirect_uri: str) -> dict[str, Any]:
        pass

    @abstractmethod
    async def refresh_token(self, refresh_token: str) -> dict[str, Any]:
        pass

    @staticmethod
    def build_url(base_url: str, params: Mapping[str, Any]) -> str:
        return f"{base_url}?{urlencode(params)}"
