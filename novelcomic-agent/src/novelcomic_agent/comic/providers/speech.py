"""HTTP TTS. The request id is the provider idempotency key."""

from __future__ import annotations

import base64
from urllib.parse import quote

import httpx

from novelcomic_agent.config import Settings

from ..audio.voice_synthesizer import ProviderTimeout, SpeechSynthesis

_VISEMES = frozenset({"closed", "half", "open"})


class HttpSpeechProvider:
    """Synthesize one line and reconcile it with the same request id.

    ``POST {endpoint}`` submits the line. ``GET {endpoint}/{requestId}`` reads an
    accepted task. A timeout or an in-progress submit raises ``ProviderTimeout``.
    Reconcile returns ``None`` while the task is still open and does not submit again.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        voice_id: str = "",
        unit_price_fen: int = 0,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not api_key.strip():
            raise ValueError("TTS environment variables are missing: COMIC_TTS_API_KEY")
        if not endpoint.strip():
            raise ValueError("TTS environment variables are missing: COMIC_TTS_ENDPOINT")
        if (
            isinstance(unit_price_fen, bool)
            or not isinstance(unit_price_fen, int)
            or unit_price_fen < 0
        ):
            raise ValueError("COMIC_TTS_UNIT_PRICE_FEN must be a non-negative integer")
        self._endpoint = endpoint.strip().rstrip("/")
        self._api_key = api_key.strip()
        self._voice_id = voice_id.strip()
        self._unit_price_fen = unit_price_fen
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    @classmethod
    def from_settings(
        cls,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> HttpSpeechProvider:
        missing: list[str] = []
        if not settings.comic_tts_api_key.strip():
            missing.append("COMIC_TTS_API_KEY")
        if not settings.comic_tts_endpoint.strip():
            missing.append("COMIC_TTS_ENDPOINT")
        if missing:
            raise ValueError("TTS environment variables are missing: " + ", ".join(missing))
        endpoint = settings.comic_tts_endpoint.strip()
        if not endpoint.startswith(("http://", "https://")):
            raise ValueError("COMIC_TTS_ENDPOINT must be an HTTP URL")
        return cls(
            endpoint=endpoint,
            api_key=settings.comic_tts_api_key,
            voice_id=settings.comic_tts_voice_id,
            unit_price_fen=settings.comic_tts_unit_price_fen,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def synthesize(
        self,
        *,
        request_id: str,
        text: str,
        voice_id: str,
    ) -> SpeechSynthesis:
        resolved_voice = voice_id.strip() or self._voice_id
        if not resolved_voice:
            raise RuntimeError("speech voice id is empty")
        try:
            response = await self._client.post(
                self._endpoint,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Idempotency-Key": request_id,
                },
                json={
                    "requestId": request_id,
                    "text": text,
                    "voiceId": resolved_voice,
                },
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeout(request_id) from exc
        speech = _interpret(response, request_id, unit_price_fen=self._unit_price_fen)
        if speech is None:
            raise ProviderTimeout(request_id)
        return speech

    async def reconcile(self, request_id: str) -> SpeechSynthesis | None:
        try:
            response = await self._client.get(
                f"{self._endpoint}/{quote(request_id, safe='')}",
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeout(request_id) from exc
        if response.status_code == 404:
            return None
        return _interpret(
            response,
            request_id,
            unit_price_fen=self._unit_price_fen,
            missing_is_open=True,
        )


def _interpret(
    response: httpx.Response,
    request_id: str,
    *,
    unit_price_fen: int,
    missing_is_open: bool = False,
) -> SpeechSynthesis | None:
    if response.status_code in {202, 204} or (missing_is_open and response.status_code == 404):
        return None
    if response.status_code in {408, 504}:
        raise ProviderTimeout(request_id)
    if response.status_code >= 400:
        raise RuntimeError(f"speech provider returned HTTP {response.status_code}")
    payload = _object(response)
    status = payload.get("status", "succeeded")
    if status == "processing":
        return None
    if status == "failed":
        raise RuntimeError("speech provider failed")
    if status != "succeeded":
        raise RuntimeError("speech provider returned an unknown status")
    audio, content_type = _audio(payload)
    provider_request_id = payload.get("providerRequestId")
    if not isinstance(provider_request_id, str) or not provider_request_id.strip():
        provider_request_id = request_id
    return SpeechSynthesis(
        audio=audio,
        duration_ms=_duration(payload),
        provider_request_id=provider_request_id,
        cost_fen=_cost(payload, unit_price_fen),
        visemes=_visemes(payload.get("visemes")),
        content_type=content_type,
    )


def _object(response: httpx.Response) -> dict[str, object]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("speech provider returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("speech provider returned invalid JSON")
    return payload


def _audio(payload: dict[str, object]) -> tuple[bytes, str]:
    encoded = payload.get("audioBase64")
    if not isinstance(encoded, str) or not encoded:
        raise RuntimeError("speech audio is missing")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise RuntimeError("speech audio is not base64") from exc
    if not audio:
        raise RuntimeError("speech audio is empty")
    content_type = payload.get("contentType")
    if not isinstance(content_type, str) or not content_type.strip():
        content_type = "audio/mpeg"
    return audio, content_type


def _duration(payload: dict[str, object]) -> int:
    value = payload.get("durationMs")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeError("speech durationMs is invalid")
    return value


def _cost(payload: dict[str, object], unit_price_fen: int) -> int:
    if "costFen" not in payload or payload.get("costFen") is None:
        return unit_price_fen
    value = payload["costFen"]
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError("speech costFen is invalid")
    return value


def _visemes(value: object) -> tuple[tuple[int, str], ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise RuntimeError("speech visemes are invalid")
    visemes: list[tuple[int, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        time_ms = item.get("timeMs")
        name = item.get("value")
        if isinstance(time_ms, bool) or not isinstance(time_ms, int) or time_ms < 0:
            continue
        if not isinstance(name, str) or name not in _VISEMES:
            continue
        visemes.append((time_ms, name))
    return tuple(visemes)
