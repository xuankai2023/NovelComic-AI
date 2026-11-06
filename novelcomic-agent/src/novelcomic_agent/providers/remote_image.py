"""Download a remote image only after the same two URL checks used by web fetch."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from novelcomic_agent.security.network import validate_resolved_url, validate_url_target


def download_remote_image(url: str, fetch: Callable[[str], Any]) -> bytes | None:
    """Fetch image bytes when both the request URL and the final URL are public.

    ``fetch`` performs the connection. This function does not pin the first DNS
    result into that connection. A blocked target or a redirect onto an internal
    address returns None and drops the body.
    """
    ok, _error = validate_url_target(url)
    if not ok:
        return None

    try:
        response = fetch(url)
    except Exception:
        return None

    final_url = _final_url(response) or url
    ok, _error = validate_resolved_url(final_url)
    if not ok:
        return None

    content = getattr(response, "content", None)
    if isinstance(content, bytes):
        return content
    if isinstance(response, bytes):
        return response
    return None


def _final_url(response: Any) -> str | None:
    if isinstance(response, (str, bytes)):
        return None
    final = getattr(response, "url", None)
    if not final:
        return None
    return str(final)
