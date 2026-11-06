"""Deterministic spriteStates used to check the Remotion item/motion contract.

Production never writes these frames itself. Remotion's applySpriteMotion is
the only writer on a committed draft. This module mirrors that function so a
fake gateway and the contract tests can require the same frames for the same
seed, assets, and dialogue timeline.
"""

from __future__ import annotations

import math
from typing import TypedDict


class SpriteFrame(TypedDict):
    frame: int
    assetId: str


def build_blink_sprite_states(
    *,
    open_asset_id: str,
    closed_asset_id: str,
    seed: int,
    duration_in_frames: int,
    fps: int = 30,
) -> list[SpriteFrame]:
    _require_duration(duration_in_frames)
    if not open_asset_id or not closed_asset_id:
        raise ValueError("Blink requires open and closed assets")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("Blink seed must be an integer")
    closed_frames = max(1, _js_round(fps * 0.08))
    interval = max(closed_frames + 1, _js_round(fps))
    phase = math.floor(_unit_from_seed(seed) * max(1, interval - closed_frames))
    states: list[SpriteFrame] = []
    _push(states, 0, open_asset_id, duration_in_frames)
    start = phase
    while start < duration_in_frames:
        _push(states, start, closed_asset_id, duration_in_frames)
        _push(states, start + closed_frames, open_asset_id, duration_in_frames)
        start += interval
    return states


def build_mouth_flap_sprite_states(
    *,
    closed_asset_id: str,
    open_asset_id: str,
    dialogue_ranges: list[tuple[int, int]],
    duration_in_frames: int,
    half_asset_id: str | None = None,
    fps: int = 30,
) -> list[SpriteFrame]:
    _require_duration(duration_in_frames)
    if not closed_asset_id or not open_asset_id:
        raise ValueError("Mouth flap requires closed and open assets")
    sequence = [
        asset_id
        for asset_id in (closed_asset_id, half_asset_id, open_asset_id)
        if asset_id
    ]
    step = max(1, math.ceil(fps / 8))
    ranges = sorted(dialogue_ranges, key=lambda item: item[0])
    previous_end = 0
    for start, duration in ranges:
        if (
            not isinstance(start, int)
            or not isinstance(duration, int)
            or duration < 1
            or start < 0
            or start + duration > duration_in_frames
        ):
            raise ValueError("Mouth flap dialogue falls outside the item")
        if start < previous_end:
            raise ValueError("Mouth flap dialogue ranges overlap")
        previous_end = start + duration
    states: list[SpriteFrame] = []
    _push(states, 0, closed_asset_id, duration_in_frames)
    for start, duration in ranges:
        viseme = 0
        frame = start
        while frame < start + duration:
            _push(states, frame, sequence[viseme % len(sequence)], duration_in_frames)
            viseme += 1
            frame += step
        end = start + duration
        last = states[-1] if states else None
        if end < duration_in_frames and last is not None and end - last["frame"] >= step:
            _push(states, end, closed_asset_id, duration_in_frames)
        elif last is not None and last["frame"] >= start:
            states[-1] = {"frame": last["frame"], "assetId": closed_asset_id}
    return states


def _require_duration(duration_in_frames: int) -> None:
    if not isinstance(duration_in_frames, int) or duration_in_frames < 1:
        raise ValueError("Sprite durationInFrames must be a positive integer")


def _push(
    states: list[SpriteFrame],
    frame: int,
    asset_id: str,
    duration_in_frames: int,
) -> None:
    if not isinstance(frame, int) or frame < 0 or frame >= duration_in_frames:
        return
    for index, state in enumerate(states):
        if state["frame"] == frame:
            states[index] = {"frame": frame, "assetId": asset_id}
            return
    previous = next(
        (state for state in reversed(states) if state["frame"] < frame),
        None,
    )
    if previous is not None and previous["assetId"] == asset_id:
        return
    states.append({"frame": frame, "assetId": asset_id})
    states.sort(key=lambda state: state["frame"])


def _unit_from_seed(seed: int) -> float:
    """Match Remotion's mulberry32-style unitFromSeed, including Math.imul."""

    state = _imul(seed + 0x6D2B79F5, 0x9E3779B1)
    unsigned = state & 0xFFFFFFFF
    state = _to_int32(unsigned ^ (unsigned >> 16))
    state = _imul(state, 0x7FEB352D)
    unsigned = state & 0xFFFFFFFF
    unsigned ^= unsigned >> 15
    return unsigned / 4294967296


def _imul(left: int, right: int) -> int:
    return _to_int32(_to_int32(left) * _to_int32(right))


def _to_int32(value: int) -> int:
    value &= 0xFFFFFFFF
    if value >= 0x80000000:
        return value - 0x100000000
    return value


def _js_round(value: float) -> int:
    if value >= 0:
        return math.floor(value + 0.5)
    return math.ceil(value - 0.5)
