"""Per-shot downgrade policy; task-level production continues."""

from dataclasses import dataclass
from typing import Literal

AnimationLevel = Literal["L0", "L1", "L2", "L3"]
QualityFailure = Literal[
    "state-patch-failed",
    "multipart-failed",
    "inpaint-failed",
    "segmentation-failed",
    "quality-failed-twice",
    "enhancement-budget-stopped",
]


@dataclass(frozen=True, slots=True)
class DowngradeDecision:
    animation_level: AnimationLevel
    reason: QualityFailure
    degraded_from: AnimationLevel | None = None


def decide_downgrade(
    current: AnimationLevel,
    reason: QualityFailure,
) -> DowngradeDecision:
    animation_level = current
    if reason == "state-patch-failed" and current in {"L2", "L3"}:
        animation_level = "L1"
    elif reason == "multipart-failed" and current == "L3":
        animation_level = "L2"
    elif reason in {"inpaint-failed", "segmentation-failed"}:
        animation_level = "L0"
    elif reason == "quality-failed-twice":
        animation_level = {"L0": "L0", "L1": "L0", "L2": "L1", "L3": "L2"}[current]
    elif reason == "enhancement-budget-stopped" and current in {"L2", "L3"}:
        animation_level = "L1"

    return DowngradeDecision(
        animation_level=animation_level,
        degraded_from=current if animation_level != current else None,
        reason=reason,
    )
