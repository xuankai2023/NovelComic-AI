"""PostHog capture that stays a no-op until a key is configured."""

from __future__ import annotations

from typing import Any

_client: Any = None


def init_posthog(*, api_key: str = "", enabled: bool = False, host: str = "") -> None:
    """Open a PostHog client. Missing key, disabled flag, or SDK errors skip it."""

    global _client
    if _client is not None or not enabled or not api_key:
        return
    try:
        from posthog import Posthog

        _client = Posthog(api_key, host=host or "https://us.i.posthog.com")
    except Exception:
        _client = None


def capture_event(event: str, properties: dict[str, Any] | None = None) -> None:
    """Capture one event. Does nothing when PostHog was not initialized."""

    if _client is None or not event:
        return
    try:
        _client.capture(
            distinct_id="anonymous",
            event=event,
            properties=dict(properties or {}),
        )
    except Exception:
        return


def capture_generation(**properties: Any) -> None:
    """Capture one model generation. Safe for the agent run loop to call."""

    capture_event("$ai_generation", properties)
