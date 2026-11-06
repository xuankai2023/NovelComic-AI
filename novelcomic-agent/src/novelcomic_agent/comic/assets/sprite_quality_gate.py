"""Deterministic blink and mouth-flap gate. It never calls a model or inpaints."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from ..contracts.sprite_state import (
    EYE_SEMANTICS,
    MOUTH_REQUIRED,
    MOUTH_SEMANTICS,
    SpriteAssetSet,
    SpriteStateAsset,
    sprite_asset_id,
)

_SHA256_LENGTH = 64
_REASON_ORDER = (
    "duplicate-semantic",
    "unknown-semantic",
    "unstable-asset-id",
    "missing-eye-state",
    "missing-mouth-state",
    "canvas-mismatch",
    "contour-drift",
    "anchor-drift",
    "bounds-mismatch",
    "opaque-edge",
    "checksum-mismatch",
)


@dataclass(frozen=True, slots=True)
class SpriteGateThresholds:
    version: str = "sprite-gate-v1"
    max_bounds_drift_px: float = 4.0
    max_anchor_drift: float = 0.02


@dataclass(frozen=True, slots=True)
class SpriteReference:
    canvas_width: int
    canvas_height: int
    bounds: tuple[float, float, float, float]
    anchor: tuple[float, float]


@dataclass(frozen=True, slots=True)
class SpriteGateResult:
    capabilities: tuple[str, ...]
    rejected_reasons: tuple[str, ...]
    warnings: tuple[str, ...]
    threshold_version: str
    mouth_semantics: tuple[str, ...]
    diagnostics: dict[str, str]

    @property
    def blink(self) -> bool:
        return "blink" in self.capabilities

    @property
    def mouth_flap(self) -> bool:
        return "mouth-flap" in self.capabilities


def evaluate_sprites(
    asset_set: SpriteAssetSet,
    *,
    reference: SpriteReference,
    checksums: Mapping[str, str | None],
    thresholds: SpriteGateThresholds | None = None,
) -> SpriteGateResult:
    """Judge blink and mouth-flap separately. The set is not modified."""

    rules = thresholds or SpriteGateThresholds()
    before = asset_set.model_dump()
    eye_reason, eye_warnings = _part_reason(
        asset_set,
        part="eye",
        required=EYE_SEMANTICS,
        allowed=EYE_SEMANTICS,
        missing_code="missing-eye-state",
        reference=reference,
        checksums=checksums,
        rules=rules,
    )
    mouth_reason = "not-requested"
    mouth_semantics: tuple[str, ...] = ()
    mouth_warnings: tuple[str, ...] = ()
    if asset_set.dialogue_present:
        mouth_reason, mouth_semantics, mouth_warnings = _mouth_reason(
            asset_set,
            reference=reference,
            checksums=checksums,
            rules=rules,
        )
    if asset_set.model_dump() != before:
        raise RuntimeError("sprite gate modified its input")
    capabilities: list[str] = []
    rejected: list[str] = []
    if eye_reason is None:
        capabilities.append("blink")
    else:
        rejected.append(eye_reason)
    if mouth_reason == "accepted":
        capabilities.append("mouth-flap")
    elif mouth_reason != "not-requested":
        rejected.append(mouth_reason)
    warnings = tuple(dict.fromkeys((*eye_warnings, *mouth_warnings, *asset_set.warnings)))
    rejected_reasons = tuple(dict.fromkeys(rejected))
    return SpriteGateResult(
        capabilities=tuple(capabilities),
        rejected_reasons=rejected_reasons,
        warnings=tuple(code for code in warnings if code and code not in rejected_reasons),
        threshold_version=rules.version,
        mouth_semantics=mouth_semantics,
        diagnostics={
            "blink": "accepted" if eye_reason is None else eye_reason,
            "mouthFlap": "accepted" if mouth_reason == "accepted" else mouth_reason,
            "thresholdVersion": rules.version,
        },
    )


def _mouth_reason(
    asset_set: SpriteAssetSet,
    *,
    reference: SpriteReference,
    checksums: Mapping[str, str | None],
    rules: SpriteGateThresholds,
) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
    reason, warnings = _part_reason(
        asset_set,
        part="mouth",
        required=MOUTH_REQUIRED,
        allowed=MOUTH_SEMANTICS,
        missing_code="missing-mouth-state",
        reference=reference,
        checksums=checksums,
        rules=rules,
    )
    if reason is not None:
        return reason, (), warnings
    half = _states(asset_set, "mouth", frozenset({"half"}))
    included = ["closed", "open"]
    extra: list[str] = []
    if len(half) == 1:
        half_failures = _state_failures(
            asset_set,
            half[0],
            reference=reference,
            checksums=checksums,
            rules=rules,
            shared_size=_shared_size(_states(asset_set, "mouth", MOUTH_REQUIRED)),
        )
        if half_failures:
            extra.append("mouth-half-rejected")
        else:
            included.append("half")
    elif len(half) > 1:
        return "duplicate-semantic", (), warnings
    return "accepted", tuple(included), tuple(dict.fromkeys((*warnings, *extra)))


def _part_reason(
    asset_set: SpriteAssetSet,
    *,
    part: str,
    required: frozenset[str],
    allowed: frozenset[str],
    missing_code: str,
    reference: SpriteReference,
    checksums: Mapping[str, str | None],
    rules: SpriteGateThresholds,
) -> tuple[str | None, tuple[str, ...]]:
    states = [state for state in asset_set.states if state.part == part]
    failures: list[str] = []
    counts: dict[str, int] = {}
    for state in states:
        counts[state.semantic] = counts.get(state.semantic, 0) + 1
        if state.semantic not in allowed:
            failures.append("unknown-semantic")
        if counts[state.semantic] > 1:
            failures.append("duplicate-semantic")
        if state.asset_id != sprite_asset_id(asset_set.shot_id, part, state.semantic):
            failures.append("unstable-asset-id")
    required_states = [state for state in states if state.semantic in required]
    if any(semantic not in counts for semantic in required):
        failures.append(missing_code)
    shared = _shared_size(required_states)
    if len({(state.width, state.height) for state in required_states}) > 1:
        failures.append("canvas-mismatch")
    for state in required_states:
        failures.extend(
            _state_failures(
                asset_set,
                state,
                reference=reference,
                checksums=checksums,
                rules=rules,
                shared_size=shared,
            )
        )
    unique = _ordered(failures)
    if unique:
        return unique[0], tuple(unique[1:])
    return None, ()


def _state_failures(
    asset_set: SpriteAssetSet,
    state: SpriteStateAsset,
    *,
    reference: SpriteReference,
    checksums: Mapping[str, str | None],
    rules: SpriteGateThresholds,
    shared_size: tuple[int, int] | None,
) -> list[str]:
    failures: list[str] = []
    if shared_size is not None and (state.width, state.height) != shared_size:
        failures.append("canvas-mismatch")
    if _exceeds(abs(state.width - state.bounds.width), 1) or _exceeds(
        abs(state.height - state.bounds.height),
        1,
    ):
        failures.append("canvas-mismatch")
    if (
        asset_set.canvas.width != reference.canvas_width
        or asset_set.canvas.height != reference.canvas_height
    ):
        failures.append("canvas-mismatch")
    bounds = (state.bounds.x, state.bounds.y, state.bounds.width, state.bounds.height)
    if _exceeds(_distance(bounds, reference.bounds), rules.max_bounds_drift_px):
        failures.append("contour-drift")
    anchor = (state.anchor.x, state.anchor.y)
    if _exceeds(_distance(anchor, reference.anchor), rules.max_anchor_drift):
        failures.append("anchor-drift")
    if state.anchor.x < 0 or state.anchor.x > 1 or state.anchor.y < 0 or state.anchor.y > 1:
        failures.append("anchor-drift")
    if (
        state.bounds.x < 0
        or state.bounds.y < 0
        or state.bounds.x + state.bounds.width > reference.canvas_width
        or state.bounds.y + state.bounds.height > reference.canvas_height
    ):
        failures.append("bounds-mismatch")
    if state.color_type not in {4, 6}:
        failures.append("opaque-edge")
    actual = checksums.get(str(state.image_url))
    if (
        actual is None
        or len(state.checksum) != _SHA256_LENGTH
        or actual != state.checksum
    ):
        failures.append("checksum-mismatch")
    return failures


def _states(
    asset_set: SpriteAssetSet,
    part: str,
    semantics: frozenset[str],
) -> list[SpriteStateAsset]:
    return [
        state
        for state in asset_set.states
        if state.part == part and state.semantic in semantics
    ]


def _shared_size(states: list[SpriteStateAsset]) -> tuple[int, int] | None:
    if not states:
        return None
    return states[0].width, states[0].height


def _distance(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return max(abs(item - other) for item, other in zip(left, right, strict=True))


def _exceeds(distance: float, limit: float) -> bool:
    """Keep the documented boundary inclusive when binary floats sit just over it."""

    return distance - limit > 1e-6


def _ordered(failures: list[str]) -> tuple[str, ...]:
    rank = {reason: index for index, reason in enumerate(_REASON_ORDER)}
    unique = dict.fromkeys(failures)
    return tuple(sorted(unique, key=lambda reason: rank.get(reason, len(rank))))
