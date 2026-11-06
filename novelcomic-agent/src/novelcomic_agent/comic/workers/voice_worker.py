"""Synthesize line audio and freeze the L0 timeline."""

from __future__ import annotations

import hashlib

from ..audio.timeline_planner import TimelineLine, TimelinePanel, plan_timeline
from ..audio.voice_synthesizer import SpeechLine, SpeechProvider, VoiceSynthesizer
from ..contracts.errors import ComicServiceError
from ..contracts.panel_spec import PanelSpec
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..repositories.production_repository import ProductionRepository, load_request
from ..storage.object_store import ObjectStore
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import TERMINAL_STATES, ProductionState
from .stage_commit import commit_stage


class VoiceWorker:
    """Own SYNTHESIZING_VOICE. A failed line stays on its missing reason."""

    def __init__(
        self,
        *,
        productions: ProductionRepository,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        provider: SpeechProvider,
        provider_name: str,
        provider_config_version: str,
        worst_case_fen: int,
    ) -> None:
        self._productions = productions
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._provider = provider
        self._provider_name = provider_name
        self._provider_config_version = provider_config_version
        self._worst_case_fen = worst_case_fen

    async def run(self, production_id: str) -> ProductionSnapshot:
        row = await self._productions.get_row(production_id)
        state = ProductionState(row.state)
        if state in TERMINAL_STATES or state is not ProductionState.SYNTHESIZING_VOICE:
            return await self._productions.get(production_id)
        if row.cancel_requested_at is not None:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "production is cancelled",
                retryable=False,
            )
        try:
            fact, degraded = await self._synthesize(row)
            await commit_stage(
                self._productions,
                production_id,
                ProductionState.SYNTHESIZING_VOICE,
                fact,
                can_produce_playable=True,
                degraded=degraded,
            )
        except ComicServiceError as exc:
            await self._productions.record_error(
                production_id,
                code=exc.code,
                message=exc.body.message,
            )
            if exc.code != "JOB_LEASE_CONFLICT":
                return await self._productions.get(production_id)
        return await self._productions.get(production_id)

    async def _synthesize(self, row: object) -> tuple[dict[str, object], bool]:
        production = row
        request = load_request(production)  # type: ignore[arg-type]
        panels = [
            PanelSpec.model_validate(item)
            for item in production.stage_facts["ANALYZING"]["panels"]  # type: ignore[attr-defined]
        ]
        speech_lines = [
            SpeechLine(
                stable_line_key=dialogue.stable_line_key,
                text=dialogue.text,
                speaker_id=dialogue.speaker_id,
            )
            for panel in panels
            for dialogue in panel.dialogues
        ]
        synthesizer = VoiceSynthesizer(
            artifacts=self._artifacts,
            costs=self._costs,
            objects=self._objects,
            provider=self._provider,
            tenant_id=production.tenant_id,  # type: ignore[attr-defined]
            production_id=production.production_id,  # type: ignore[attr-defined]
            project_id=production.project_id,  # type: ignore[attr-defined]
            provider_name=self._provider_name,
            provider_config_version=self._provider_config_version,
            worst_case_fen=self._worst_case_fen,
            voices=request.voices,
            default_voice_id=request.default_voice_id,
        )
        audios = await synthesizer.synthesize_lines(speech_lines)
        by_key = {audio.stable_line_key: audio for audio in audios}
        timeline_panels = [
            TimelinePanel(
                page_id=panel.page_id,
                panel_index=panel.panel_index,
                reading_order=panel.reading_order,
                panel_url=str(panel.panel_url),
                lines=tuple(
                    TimelineLine(
                        stable_line_key=dialogue.stable_line_key,
                        text=dialogue.text,
                        speaker_id=dialogue.speaker_id,
                        audio=by_key.get(dialogue.stable_line_key),
                        bubble_polygon=tuple(dialogue.bubble_polygon)
                        if dialogue.bubble_polygon
                        else None,
                    )
                    for dialogue in panel.dialogues
                ),
            )
            for panel in panels
        ]
        seed = int.from_bytes(
            hashlib.sha256(production.production_id.encode()).digest()[:4],  # type: ignore[attr-defined]
            "big",
        ) & 0x7FFFFFFF
        plan = plan_timeline(timeline_panels, seed=seed or 1)
        missing = [audio.stable_line_key for audio in audios if audio.missing_reason]
        return (
            {
                "shots": [shot.model_dump(mode="json") for shot in plan.shots],
                "totalFrames": plan.total_frames,
                "needsProjectPad": plan.needs_project_pad,
                "missingLines": missing,
            },
            bool(missing) or bool(production.stage_facts["ANALYZING"].get("degraded")),  # type: ignore[attr-defined]
        )
