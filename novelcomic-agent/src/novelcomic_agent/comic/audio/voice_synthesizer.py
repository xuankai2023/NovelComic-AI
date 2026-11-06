"""Stable-line TTS with artifact reuse, budget reserve, and provider reconciliation."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

from ..canonical import hash_content
from ..contracts.errors import ComicServiceError
from ..contracts.ids import make_shot_id
from ..contracts.line_audio import LineAudio, TimedViseme
from ..persistence.rows import ArtifactRow
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..storage.key_layout import artifact_object_key
from ..storage.object_store import ObjectStore
from ..workflow.cost_budget import CostReservation


class ProviderTimeout(Exception):
    """The provider may already have accepted this request id."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.request_id = request_id


@dataclass(frozen=True, slots=True)
class SpeechSynthesis:
    audio: bytes
    duration_ms: int
    provider_request_id: str
    cost_fen: int
    visemes: tuple[tuple[int, str], ...] = ()
    content_type: str = "audio/mpeg"


@dataclass(frozen=True, slots=True)
class SpeechLine:
    stable_line_key: str
    text: str
    speaker_id: str | None = None


class SpeechProvider(Protocol):
    async def synthesize(
        self,
        *,
        request_id: str,
        text: str,
        voice_id: str,
    ) -> SpeechSynthesis:
        """Synthesize one line. The request id is the provider idempotency key."""

    async def reconcile(self, request_id: str) -> SpeechSynthesis | None:
        """Return an already accepted synthesis, or None while it is still open."""


class VoiceSynthesizer:
    def __init__(
        self,
        *,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        provider: SpeechProvider,
        tenant_id: str,
        production_id: str,
        project_id: str,
        provider_name: str,
        provider_config_version: str,
        worst_case_fen: int,
        voices: dict[str, str] | None,
        default_voice_id: str,
    ) -> None:
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._provider = provider
        self._tenant_id = tenant_id
        self._production_id = production_id
        self._project_id = project_id
        self._provider_name = provider_name
        self._provider_config_version = provider_config_version
        self._worst_case_fen = worst_case_fen
        self._voices = voices or {}
        self._default_voice_id = default_voice_id

    async def synthesize_lines(self, lines: list[SpeechLine]) -> list[LineAudio]:
        seen: set[str] = set()
        results: list[LineAudio] = []
        for line in lines:
            if line.stable_line_key in seen:
                continue
            seen.add(line.stable_line_key)
            results.append(await self._synthesize_one(line))
        return results

    async def apply_callback(
        self,
        *,
        provider_request_id: str,
        audio: bytes,
        duration_ms: int,
        cost_fen: int,
        visemes: tuple[tuple[int, str], ...] = (),
    ) -> LineAudio:
        """Settle one provider callback. A duplicate callback does not charge again."""

        existing = await self._costs.find_by_provider_request(provider_request_id)
        if existing is None:
            raise ComicServiceError(
                "PROVIDER_RECONCILIATION_REQUIRED",
                "callback does not match an open provider request",
                retryable=True,
            )
        artifact = await self._artifacts.get(existing.cost_entry_id)
        if artifact is None:
            raise ComicServiceError(
                "PROVIDER_RECONCILIATION_REQUIRED",
                "callback artifact is missing",
                retryable=True,
            )
        if existing.status == "settled" or artifact.status == "completed":
            return _line_from_artifact(artifact)
        line_key = str(artifact.diagnostics.get("lineKey") or "")
        if not line_key:
            raise ComicServiceError(
                "PROVIDER_RECONCILIATION_REQUIRED",
                "callback artifact has no line key",
                retryable=False,
            )
        return await self._store_audio(
            artifact_id=artifact.artifact_id,
            reservation_id=existing.cost_entry_id,
            speech=SpeechSynthesis(
                audio=audio,
                duration_ms=duration_ms,
                provider_request_id=provider_request_id,
                cost_fen=cost_fen,
                visemes=visemes,
            ),
            line_key=line_key,
        )

    async def _synthesize_one(self, line: SpeechLine) -> LineAudio:
        voice_id, missing = _resolve_voice(
            line.speaker_id,
            self._voices,
            self._default_voice_id,
        )
        input_hash = _input_hash(line, voice_id or "missing", self._provider_config_version)
        artifact_id = f"tts:{self._production_id}:{input_hash[:32]}"
        shot_id = _billing_shot_id(line.stable_line_key)
        if missing is not None or voice_id is None:
            return await self._terminal_missing(
                line,
                missing or "unknown-speaker",
                artifact_id=artifact_id,
                input_hash=input_hash,
                shot_id=shot_id,
            )
        claim = await self._artifacts.claim(
            tenant_id=self._tenant_id,
            project_id=self._project_id,
            stage="tts",
            input_hash=input_hash,
            artifact_id=artifact_id,
            provider=self._provider_name,
            shot_id=shot_id,
        )
        artifact = claim.artifact
        if artifact.status == "completed":
            return _line_from_artifact(artifact)
        if claim.exhausted:
            return _missing(line.stable_line_key, "tts-failed")
        if artifact.provider_request_id:
            reconciled = await self._provider.reconcile(artifact.provider_request_id)
            if reconciled is not None:
                return await self._store_audio(
                    artifact_id=artifact.artifact_id,
                    reservation_id=artifact.artifact_id,
                    speech=reconciled,
                    line_key=line.stable_line_key,
                )
            if artifact.diagnostics.get("reconciliationRequired"):
                raise ComicServiceError(
                    "PROVIDER_RECONCILIATION_REQUIRED",
                    "provider result is not ready to reconcile",
                    retryable=True,
                    details={"providerRequestId": artifact.provider_request_id},
                )
        return await self._speak(artifact, line, voice_id)

    async def _speak(self, artifact: ArtifactRow, line: SpeechLine, voice_id: str) -> LineAudio:
        await self._artifacts.update_diagnostics(
            artifact.artifact_id,
            {"lineKey": line.stable_line_key},
        )
        await self._artifacts.attach_provider_request(artifact.artifact_id, artifact.artifact_id)
        reserved = await self._costs.reserve_operation(
            CostReservation(
                reservation_id=artifact.artifact_id,
                production_id=self._production_id,
                worst_case_fen=self._worst_case_fen,
                shot_id=artifact.shot_id,
                provider_request_id=artifact.artifact_id,
            ),
            provider=self._provider_name,
        )
        if not reserved:
            await self._artifacts.fail(
                artifact.artifact_id,
                diagnostics={
                    "missingReason": "budget-exceeded",
                    "lineKey": line.stable_line_key,
                },
            )
            return _missing(line.stable_line_key, "budget-exceeded")
        try:
            speech = await self._provider.synthesize(
                request_id=artifact.artifact_id,
                text=line.text,
                voice_id=voice_id,
            )
        except ProviderTimeout as exc:
            await self._artifacts.update_diagnostics(
                artifact.artifact_id,
                {"reconciliationRequired": True, "lineKey": line.stable_line_key},
            )
            await self._costs.mark_reconciliation(artifact.artifact_id, exc.request_id)
            raise ComicServiceError(
                "PROVIDER_RECONCILIATION_REQUIRED",
                "provider timed out after accepting the line",
                retryable=True,
                details={"providerRequestId": exc.request_id},
            ) from exc
        except Exception:
            await self._costs.release(artifact.artifact_id)
            await self._artifacts.fail(
                artifact.artifact_id,
                diagnostics={
                    "missingReason": "provider-failed",
                    "lineKey": line.stable_line_key,
                },
            )
            return _missing(line.stable_line_key, "provider-failed")
        return await self._store_audio(
            artifact_id=artifact.artifact_id,
            reservation_id=artifact.artifact_id,
            speech=speech,
            line_key=line.stable_line_key,
        )

    async def _store_audio(
        self,
        *,
        artifact_id: str,
        reservation_id: str,
        speech: SpeechSynthesis,
        line_key: str,
    ) -> LineAudio:
        digest = hashlib.sha256(speech.audio).hexdigest()
        key = artifact_object_key(
            tenant_id=self._tenant_id,
            production_id=self._production_id,
            stage="tts",
            name=_name_for_line(line_key),
            checksum=digest,
        )
        stored = await self._objects.put_verified(
            key,
            speech.audio,
            content_type=speech.content_type,
        )
        if stored != digest or await self._objects.checksum(key) != digest:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "uploaded voice checksum mismatch",
                retryable=True,
            )
        visemes = [
            TimedViseme(time_ms=time_ms, value=value)  # type: ignore[arg-type]
            for time_ms, value in speech.visemes
        ]
        audio = LineAudio(
            stable_line_key=line_key,  # type: ignore[arg-type]
            audio_url=self._objects.stable_url(key),  # type: ignore[arg-type]
            duration_ms=speech.duration_ms,
            provider_request_id=speech.provider_request_id,
            visemes=visemes or None,
        )
        await self._costs.settle(reservation_id, speech.cost_fen)
        await self._artifacts.complete(
            artifact_id,
            urls=[self._objects.stable_url(key)],
            checksums=[digest],
            diagnostics={
                "line": audio.model_dump(mode="json", by_alias=True),
                "objectKey": key,
                "lineKey": line_key,
            },
            cost_fen=speech.cost_fen,
            provider_request_id=speech.provider_request_id,
        )
        return audio

    async def _terminal_missing(
        self,
        line: SpeechLine,
        reason: str,
        *,
        artifact_id: str,
        input_hash: str,
        shot_id: str,
    ) -> LineAudio:
        claim = await self._artifacts.claim(
            tenant_id=self._tenant_id,
            project_id=self._project_id,
            stage="tts",
            input_hash=input_hash,
            artifact_id=artifact_id,
            provider=self._provider_name,
            shot_id=shot_id,
        )
        if claim.artifact.status == "completed":
            return _line_from_artifact(claim.artifact)
        audio = _missing(line.stable_line_key, reason)
        placeholder = hashlib.sha256(f"{reason}:{line.stable_line_key}".encode()).hexdigest()
        await self._artifacts.complete(
            claim.artifact.artifact_id,
            urls=[f"https://objects.novelcomic.local/missing/{placeholder}"],
            checksums=[placeholder],
            diagnostics={"line": audio.model_dump(mode="json", by_alias=True)},
            cost_fen=0,
        )
        return audio


def _resolve_voice(
    speaker_id: str | None,
    voices: dict[str, str],
    default_voice_id: str,
) -> tuple[str | None, str | None]:
    if speaker_id is None:
        return default_voice_id, None
    if speaker_id == "speaker:unknown":
        return None, "unknown-speaker"
    mapped = voices.get(speaker_id)
    if mapped:
        return mapped, None
    return None, "unknown-speaker"


def _input_hash(line: SpeechLine, voice_id: str, provider_config_version: str) -> str:
    return hash_content(
        {
            "providerConfigVersion": provider_config_version,
            "stableLineKey": line.stable_line_key,
            "text": " ".join(line.text.split()),
            "voiceId": voice_id,
        }
    )


def _billing_shot_id(stable_line_key: str) -> str:
    _prefix, page_id, panel, bubble, clause = stable_line_key.split(":")
    return make_shot_id(page_id, int(panel), int(bubble) * 1000 + int(clause))


def _missing(stable_line_key: str, reason: str) -> LineAudio:
    return LineAudio(
        stable_line_key=stable_line_key,  # type: ignore[arg-type]
        missing_reason=reason,
    )


def _line_from_artifact(artifact: ArtifactRow) -> LineAudio:
    payload = artifact.diagnostics.get("line")
    if isinstance(payload, dict):
        return LineAudio.model_validate(payload)
    reason = str(artifact.diagnostics.get("missingReason") or "tts-failed")
    line_key = str(artifact.diagnostics.get("lineKey") or "")
    if not line_key:
        raise ValueError("cached voice artifact has no line")
    return _missing(line_key, reason)


def _name_for_line(stable_line_key: str) -> str:
    return stable_line_key.replace(":", "_")
