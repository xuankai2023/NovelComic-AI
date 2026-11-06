"""Dialogue and voice payloads shared by Compose and mouth-flap.

The asset worker must submit the same dialogue command the render worker
replays later. A second payload would be a second command id.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..contracts.errors import ComicServiceError
from ..contracts.timed_shot_spec import TimedShotSpec
from ..units import absolute_from_frame


def dialogue_and_voice_payloads(
    shots: list[TimedShotSpec],
    placed: Mapping[str, Mapping[str, Any]],
    *,
    subtitle_mode: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    dialogue_lines: list[dict[str, Any]] = []
    voice_lines: list[dict[str, Any]] = []
    for shot in shots:
        committed = placed.get(shot.shot_id)
        if committed is None:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "image sequence did not commit the shot",
                retryable=True,
                details={"shotId": shot.shot_id},
            )
        for dialogue in shot.dialogues:
            absolute = absolute_from_frame(int(committed["from"]), dialogue.from_frame)
            missing_voice = dialogue.voice_url is None
            visible = missing_voice or subtitle_mode == "clean-bubble-and-caption"
            dialogue_lines.append(
                {
                    "lineId": dialogue.line_id,
                    "shotId": shot.shot_id,
                    "text": dialogue.text,
                    "from": absolute,
                    "durationInFrames": dialogue.duration_in_frames,
                    "visible": visible,
                }
            )
            if dialogue.voice_url is not None:
                voice_lines.append(
                    {
                        "shotId": shot.shot_id,
                        "lineId": dialogue.line_id,
                        "audioUrl": str(dialogue.voice_url),
                        "from": absolute,
                        "durationInFrames": dialogue.duration_in_frames,
                    }
                )
    dialogue = {"lines": dialogue_lines} if dialogue_lines else None
    voice = {"voices": voice_lines} if voice_lines else None
    return dialogue, voice
