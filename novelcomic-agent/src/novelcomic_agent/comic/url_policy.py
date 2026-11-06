"""HTTPS allowlist shared by source download and Remotion payloads."""

from __future__ import annotations

from urllib.parse import urlsplit

from .contracts.errors import ComicServiceError


def require_allowed_https(url: str, allowed_hosts: frozenset[str]) -> str:
    """Reject non-HTTPS URLs and hosts outside the production allowlist."""

    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.username or parts.password:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "URL must be HTTPS without embedded credentials",
            retryable=False,
        )
    if host not in allowed_hosts:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "URL host is not allowlisted",
            retryable=False,
            details={"host": host},
        )
    return url
