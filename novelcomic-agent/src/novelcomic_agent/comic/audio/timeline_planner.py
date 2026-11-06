"""Freeze shot-relative timelines from measured audio durations."""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..contracts.ids import PageId, make_shot_id
from ..contracts.line_audio import LineAudio
from ..contracts.panel_spec import Point
from ..contracts.timed_shot_spec import FrameViseme, TimedDialogueSpec, TimedShotSpec
from ..units import FPS, MIN_PROJECT_FRAMES, frames_from_ms

LEAD_FRAMES = 6
TAIL_FRAMES = 6
GAP_FRAMES = 4
MIN_SHOT_FRAMES = 15
MAX_PART_FRAMES = 8 * FPS
_CAMERAS = ("camera-push", "camera-pull", "pan-left", "pan-right")


@dataclass(frozen=True, slots=True)
class TimelineLine:
    stable_line_key: str
    text: str
    speaker_id: str | None
    audio: LineAudio | None = None
    bubble_polygon: tuple[Point, ...] | None = None


@dataclass(frozen=True, slots=True)
class TimelinePanel:
    page_id: PageId
    panel_index: int
    reading_order: int
    panel_url: str
    lines: tuple[TimelineLine, ...]


@dataclass(frozen=True, slots=True)
class TimelinePlan:
    shots: tuple[TimedShotSpec, ...]
    total_frames: int

    @property
    def needs_project_pad(self) -> bool:
        return self.total_frames < MIN_PROJECT_FRAMES


def plan_timeline(
    panels: list[TimelinePanel] | tuple[TimelinePanel, ...],
    *,
    seed: int,
) -> TimelinePlan:
    """Build a deterministic L0 timeline. The same panels and seed always match."""

    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("seed must be an integer")
    shots: list[TimedShotSpec] = []
    for panel in panels:
        shots.extend(_panel_shots(panel, seed))
    total = sum(shot.duration_in_frames for shot in shots)
    return TimelinePlan(shots=tuple(shots), total_frames=total)


def _panel_shots(panel: TimelinePanel, seed: int) -> list[TimedShotSpec]:
    groups = _split_lines(panel.lines)
    shots: list[TimedShotSpec] = []
    for part_index, group in enumerate(groups):
        dialogues: list[TimedDialogueSpec] = []
        cursor = LEAD_FRAMES
        for index, line in enumerate(group):
            if index:
                cursor += GAP_FRAMES
            duration = _line_frames(line)
            dialogues.append(_dialogue(line, cursor, duration))
            cursor += duration
        duration = max(MIN_SHOT_FRAMES, cursor + TAIL_FRAMES)
        preset = _CAMERAS[(seed + panel.reading_order + part_index) % len(_CAMERAS)]
        shots.append(
            TimedShotSpec(
                shot_id=make_shot_id(panel.page_id, panel.reading_order, part_index),
                page_id=panel.page_id,
                panel_index=panel.panel_index,
                panel_part_index=part_index,
                panel_url=panel.panel_url,  # type: ignore[arg-type]
                animation_level="L0",
                duration_in_frames=duration,
                camera_preset_id=preset,  # type: ignore[arg-type]
                seed=seed + part_index,
                dialogues=dialogues,
            )
        )
    return shots


def _split_lines(lines: tuple[TimelineLine, ...]) -> list[tuple[TimelineLine, ...]]:
    if not lines:
        return [()]
    groups: list[list[TimelineLine]] = []
    current: list[TimelineLine] = []
    current_frames = LEAD_FRAMES
    for line in lines:
        frames = _line_frames(line)
        extra = frames + (GAP_FRAMES if current else 0)
        if current and current_frames + extra + TAIL_FRAMES > MAX_PART_FRAMES:
            groups.append(current)
            current = [line]
            current_frames = LEAD_FRAMES + frames
            continue
        current.append(line)
        current_frames += extra
    if current:
        groups.append(current)
    return [tuple(group) for group in groups]


def _line_frames(line: TimelineLine) -> int:
    if line.audio is not None and line.audio.duration_ms is not None:
        return max(1, frames_from_ms(line.audio.duration_ms))
    text_frames = math.ceil(max(len(line.text), 1) / 15 * FPS)
    return max(MIN_SHOT_FRAMES, min(120, text_frames))


def _dialogue(line: TimelineLine, start: int, duration: int) -> TimedDialogueSpec:
    audio = line.audio
    visemes = None
    if audio is not None and audio.visemes:
        visemes = [
            FrameViseme(
                frame=min(duration - 1, frames_from_ms(mark.time_ms)),
                value=mark.value,
            )
            for mark in audio.visemes
        ]
    return TimedDialogueSpec(
        line_id=line.stable_line_key,  # type: ignore[arg-type]
        stable_line_key=line.stable_line_key,  # type: ignore[arg-type]
        text=line.text,
        speaker_id=line.speaker_id,  # type: ignore[arg-type]
        bubble_polygon=list(line.bubble_polygon) if line.bubble_polygon else None,
        from_frame=start,
        duration_in_frames=duration,
        voice_url=None if audio is None else audio.audio_url,
        visemes=visemes,
    )
