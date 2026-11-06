"""Voice cache, budget, partial failure, callback, and reconciliation."""

from __future__ import annotations

import pytest

from novelcomic_agent.comic.audio.voice_synthesizer import SpeechLine, VoiceSynthesizer
from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.contracts.ids import make_stable_line_key, page_id_from_bytes
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.repositories.artifact_repository import ArtifactRepository
from novelcomic_agent.comic.repositories.cost_repository import CostRepository
from novelcomic_agent.comic.repositories.production_repository import ProductionRepository
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from tests.comic_support import ScriptedSpeech, empty_project, production_request

PAGE = page_id_from_bytes(b"voice-page")


def _line(text: str, bubble: int = 0, *, speaker: str | None = None) -> SpeechLine:
    return SpeechLine(
        stable_line_key=make_stable_line_key(PAGE, 0, bubble, 0),
        text=text,
        speaker_id=speaker,
    )


async def _synthesizer(
    *,
    project_limit: str = "100.00",
    worst_case_fen: int = 100,
) -> tuple[VoiceSynthesizer, ScriptedSpeech, ProductionRepository, str]:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(project_limit=project_limit, shot_limit="10.00", max_calls=5),
        project=empty_project(),
        content_hash=project_content_hash(empty_project()),
        production_id="prod_voice",
        project_id="prj_voice",
    )
    speech = ScriptedSpeech()
    synthesizer = VoiceSynthesizer(
        artifacts=ArtifactRepository(ledger),
        costs=CostRepository(ledger),
        objects=MemoryObjectStore(),
        provider=speech,
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        project_id=accepted.project_id,
        provider_name="tts",
        provider_config_version="tts-v1",
        worst_case_fen=worst_case_fen,
        voices=None,
        default_voice_id="voice-default",
    )
    return synthesizer, speech, productions, accepted.production_id


async def test_cache_hit_does_not_call_the_provider_again() -> None:
    synthesizer, speech, _productions, _production_id = await _synthesizer()
    first = await synthesizer.synthesize_lines([_line("hello")])
    second = await synthesizer.synthesize_lines([_line("hello")])
    assert first[0].audio_url == second[0].audio_url
    assert speech.calls == 1


async def test_budget_miss_does_not_call_the_provider() -> None:
    synthesizer, speech, _productions, _production_id = await _synthesizer(
        project_limit="0.01",
        worst_case_fen=100,
    )
    audio = await synthesizer.synthesize_lines([_line("hello")])
    assert audio[0].missing_reason == "budget-exceeded"
    assert speech.calls == 0


async def test_one_line_can_fail_without_dropping_the_other() -> None:
    synthesizer, speech, _productions, _production_id = await _synthesizer()
    speech.fail_text = "bad"
    audios = await synthesizer.synthesize_lines([_line("good", 0), _line("bad", 1)])
    assert audios[0].audio_url is not None
    assert audios[1].missing_reason == "provider-failed"
    assert speech.calls == 2


async def test_duplicate_callback_does_not_settle_twice() -> None:
    synthesizer, speech, productions, production_id = await _synthesizer()
    audio = (await synthesizer.synthesize_lines([_line("hello")]))[0]
    before = (await productions.get_row(production_id)).actual_cost_fen
    again = await synthesizer.apply_callback(
        provider_request_id=audio.provider_request_id or "",
        audio=b"hello",
        duration_ms=800,
        cost_fen=10,
    )
    after = (await productions.get_row(production_id)).actual_cost_fen
    assert again.stable_line_key == audio.stable_line_key
    assert after == before == 10
    assert speech.calls == 1


async def test_unknown_speaker_is_not_billed() -> None:
    synthesizer, speech, productions, production_id = await _synthesizer()
    audio = await synthesizer.synthesize_lines([_line("hello", speaker="speaker:unknown")])
    row = await productions.get_row(production_id)
    assert audio[0].missing_reason == "unknown-speaker"
    assert audio[0].audio_url is None
    assert speech.calls == 0
    assert row.actual_cost_fen == 0
    assert row.reserved_cost_fen == 0


async def test_timeout_reconciles_without_a_second_reservation() -> None:
    synthesizer, speech, productions, production_id = await _synthesizer()
    line = _line("hello")
    speech.timeout_once = True
    with pytest.raises(ComicServiceError) as caught:
        await synthesizer.synthesize_lines([line])
    assert caught.value.code == "PROVIDER_RECONCILIATION_REQUIRED"
    held = await productions.get_row(production_id)
    assert held.reserved_cost_fen == 100
    assert speech.calls == 1

    original_calls = speech.calls
    audio = await synthesizer.synthesize_lines([line])
    row = await productions.get_row(production_id)
    assert audio[0].audio_url is not None
    assert speech.calls == original_calls
    assert row.reserved_cost_fen == 0
    assert row.actual_cost_fen == 10
