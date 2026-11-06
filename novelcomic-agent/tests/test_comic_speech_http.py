"""HTTP speech provider: idempotent submit, reconcile, and startup config."""

from __future__ import annotations

import base64
import json
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI

from novelcomic_agent.comic.audio.voice_synthesizer import (
    ProviderTimeout,
    SpeechLine,
    VoiceSynthesizer,
)
from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.ids import make_stable_line_key, page_id_from_bytes
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.providers.speech import HttpSpeechProvider
from novelcomic_agent.comic.repositories.artifact_repository import ArtifactRepository
from novelcomic_agent.comic.repositories.cost_repository import CostRepository
from novelcomic_agent.comic.repositories.production_repository import ProductionRepository
from novelcomic_agent.comic.runtime import start_stage_b_process
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.config import Settings
from tests.comic_support import (
    MemoryFetcher,
    ScriptedRemotion,
    empty_project,
    production_request,
)

_PAGE = page_id_from_bytes(b"voice-page")
_AUDIO = b"audio-bytes"


def _line(text: str, bubble: int = 0) -> SpeechLine:
    return SpeechLine(
        stable_line_key=make_stable_line_key(_PAGE, 0, bubble, 0),
        text=text,
    )


def _payload(
    request_id: str,
    *,
    cost_fen: int | None = 10,
    visemes: list[dict[str, object]] | None = None,
    include_visemes: bool = False,
) -> dict[str, object]:
    body: dict[str, object] = {
        "status": "succeeded",
        "audioBase64": base64.b64encode(_AUDIO).decode("ascii"),
        "durationMs": 800,
        "providerRequestId": request_id,
        "contentType": "audio/mpeg",
    }
    if cost_fen is not None:
        body["costFen"] = cost_fen
    if include_visemes:
        body["visemes"] = visemes or []
    return body


def _provider(
    handler,
    *,
    unit_price_fen: int = 10,
) -> HttpSpeechProvider:
    return HttpSpeechProvider(
        endpoint="https://tts.example/v1/speech",
        api_key="tts-key",
        voice_id="voice-default",
        unit_price_fen=unit_price_fen,
        transport=httpx.MockTransport(handler),
    )


async def _synthesizer(
    provider: HttpSpeechProvider,
) -> tuple[VoiceSynthesizer, ProductionRepository, str]:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(project_limit="100.00", shot_limit="10.00", max_calls=5),
        project=empty_project(),
        content_hash=project_content_hash(empty_project()),
        production_id="prod_voice",
        project_id="prj_voice",
    )
    synthesizer = VoiceSynthesizer(
        artifacts=ArtifactRepository(ledger),
        costs=CostRepository(ledger),
        objects=MemoryObjectStore(),
        provider=provider,
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        project_id=accepted.project_id,
        provider_name="tts",
        provider_config_version="tts-v1",
        worst_case_fen=100,
        voices=None,
        default_voice_id="voice-default",
    )
    return synthesizer, productions, accepted.production_id


def test_missing_tts_settings_name_the_variable() -> None:
    with pytest.raises(ValueError, match="COMIC_TTS_API_KEY") as missing_key:
        HttpSpeechProvider.from_settings(
            Settings(
                comic_tts_endpoint="https://tts.example/v1/speech",
                comic_tts_api_key="",
            )
        )
    assert "COMIC_TTS_ENDPOINT" not in str(missing_key.value)
    with pytest.raises(ValueError, match="COMIC_TTS_ENDPOINT"):
        HttpSpeechProvider.from_settings(
            Settings(comic_tts_api_key="tts-key", comic_tts_endpoint="")
        )
    with pytest.raises(ValueError, match="COMIC_TTS_ENDPOINT must be an HTTP URL"):
        HttpSpeechProvider.from_settings(
            Settings(comic_tts_api_key="tts-key", comic_tts_endpoint="tts.example/speech")
        )


async def test_stage_b_startup_fails_when_the_tts_key_is_missing(monkeypatch) -> None:
    async def migrations(pool: object) -> list[str]:
        del pool
        return []

    class _Broker:
        async def publish(self, body: dict[str, object]) -> None:
            del body

        async def consume(self, handler: object) -> None:
            del handler

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr("novelcomic_agent.comic.runtime.apply_migrations", migrations)
    with pytest.raises(ValueError, match="COMIC_TTS_API_KEY"):
        await start_stage_b_process(
            FastAPI(),
            settings=Settings(
                comic_tts_endpoint="https://tts.example/v1/speech",
                comic_tts_api_key="",
            ),
            pool=object(),
            objects=MemoryObjectStore(),
            remotion=ScriptedRemotion(),
            fetcher=MemoryFetcher({}),
            broker=_Broker(),  # type: ignore[arg-type]
        )


async def test_synthesize_uses_the_request_id_and_optional_visemes() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json=_payload(
                body["requestId"],
                visemes=[
                    {"timeMs": 0, "value": "open"},
                    {"timeMs": 40, "value": "nope"},
                ],
                include_visemes=True,
            ),
        )

    provider = _provider(handler)
    try:
        speech = await provider.synthesize(
            request_id="tts:line-1",
            text="你好",
            voice_id="voice-actor",
        )
    finally:
        await provider.aclose()
    assert speech.audio == _AUDIO
    assert speech.duration_ms == 800
    assert speech.provider_request_id == "tts:line-1"
    assert speech.cost_fen == 10
    assert speech.visemes == ((0, "open"),)
    assert speech.content_type == "audio/mpeg"
    assert seen[0].method == "POST"
    assert seen[0].headers["authorization"] == "Bearer tts-key"
    assert seen[0].headers["idempotency-key"] == "tts:line-1"
    assert json.loads(seen[0].content) == {
        "requestId": "tts:line-1",
        "text": "你好",
        "voiceId": "voice-actor",
    }


async def test_missing_visemes_and_cost_use_empty_and_the_unit_price() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json=_payload(body["requestId"], cost_fen=None))

    provider = _provider(handler, unit_price_fen=12)
    try:
        speech = await provider.synthesize(request_id="tts:line-2", text="你好", voice_id="voice")
    finally:
        await provider.aclose()
    assert speech.visemes == ()
    assert speech.cost_fen == 12


async def test_in_progress_submit_raises_timeout_for_the_same_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        return httpx.Response(202, json={"status": "processing"})

    provider = _provider(handler)
    try:
        with pytest.raises(ProviderTimeout) as timed_out:
            await provider.synthesize(request_id="tts:line-open", text="你好", voice_id="voice")
    finally:
        await provider.aclose()
    assert timed_out.value.request_id == "tts:line-open"


async def test_timeout_and_in_progress_submit_do_not_charge_again() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if request.method == "POST":
            raise httpx.ReadTimeout("slow")
        return httpx.Response(202, json={"status": "processing"})

    provider = _provider(handler)
    try:
        with pytest.raises(ProviderTimeout) as timed_out:
            await provider.synthesize(request_id="tts:line-3", text="你好", voice_id="voice")
        assert timed_out.value.request_id == "tts:line-3"
        assert await provider.reconcile("tts:line-3") is None
    finally:
        await provider.aclose()
    assert calls == ["POST", "GET"]


async def test_reconcile_returns_the_accepted_audio_without_a_new_submit() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert quote("tts:line-4", safe="") in str(request.url)
        return httpx.Response(200, json=_payload("provider-9", cost_fen=8))

    provider = _provider(handler)
    try:
        speech = await provider.reconcile("tts:line-4")
    finally:
        await provider.aclose()
    assert speech is not None
    assert speech.audio == _AUDIO
    assert speech.provider_request_id == "provider-9"
    assert speech.cost_fen == 8
    assert speech.visemes == ()


async def test_repeat_line_does_not_call_the_provider_again() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        return httpx.Response(200, json=_payload(body["requestId"]))

    provider = _provider(handler)
    synthesizer, _productions, _production_id = await _synthesizer(provider)
    try:
        first = await synthesizer.synthesize_lines([_line("你好")])
        second = await synthesizer.synthesize_lines([_line("你好")])
    finally:
        await provider.aclose()
    assert first[0].audio_url == second[0].audio_url
    assert calls == 1


async def test_one_failed_line_keeps_the_other_audio() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["text"] == "bad":
            return httpx.Response(500, text="no")
        return httpx.Response(200, json=_payload(body["requestId"]))

    provider = _provider(handler)
    synthesizer, _productions, _production_id = await _synthesizer(provider)
    try:
        audios = await synthesizer.synthesize_lines([_line("good", 0), _line("bad", 1)])
    finally:
        await provider.aclose()
    assert audios[0].audio_url is not None
    assert audios[0].missing_reason is None
    assert audios[1].missing_reason == "provider-failed"
