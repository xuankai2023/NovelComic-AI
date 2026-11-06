"""HTTPS image fetch that does not follow redirects."""

from __future__ import annotations

from typing import Protocol

import httpx

from ..contracts.errors import ComicServiceError
from ..url_policy import require_allowed_https


class ImageFetcher(Protocol):
    async def fetch(self, url: str) -> bytes:
        """Download one admitted source image."""


class HttpxImageFetcher:
    def __init__(
        self,
        allowed_hosts: frozenset[str],
        *,
        timeout_seconds: float = 30,
        max_bytes: int = 20_000_000,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._allowed_hosts = allowed_hosts
        self._max_bytes = max_bytes
        self._client = httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=False,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch(self, url: str) -> bytes:
        require_allowed_https(url, self._allowed_hosts)
        try:
            response = await self._client.get(url)
        except httpx.HTTPError as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "source image download failed",
                retryable=True,
            ) from exc
        if response.status_code >= 400:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "source image download was rejected",
                retryable=response.status_code >= 500,
                details={"status": response.status_code},
            )
        if len(response.content) > self._max_bytes:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "source image exceeds the size limit",
                retryable=False,
            )
        return response.content
