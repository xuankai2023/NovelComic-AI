"""Map review issues onto one whitelist of Compose commands.

The second reviewing pass, a stale draft, or a command that would remove the
playable plate rejects the whole plan. Partial application is not a fallback.
"""

from __future__ import annotations

from typing import Any

from ..contracts.fix_plan import FixPlan
from ..contracts.review import ReviewIssue, ReviewReport
from ..rendering.commands import compose_command
from ..workflow.downgrade_policy import decide_downgrade

ALLOWED_ACTIONS = frozenset(
    {
        "adjust-shot-duration",
        "set-camera-preset",
        "adjust-item-motion",
        "downgrade-level",
        "restore-subtitle-visibility",
    }
)
ALLOWED_COMMANDS = frozenset({"shot/edit", "item/motion", "layers/restore-l0", "dialogue/add"})
CAMERA_PRESETS = frozenset({"camera-push", "camera-pull", "pan-left", "pan-right"})
ITEM_PRESETS = frozenset({"breathing", "float", "hair-sway"})
_FORBIDDEN_KEYS = frozenset({"patch", "ops", "jsonPatch", "json", "url", "remoteUrl", "imageUrl"})


class FixPolicy:
    def decide(
        self,
        *,
        report: ReviewReport,
        project: dict[str, Any],
        project_id: str,
        revision: int,
        fixing_count: int,
    ) -> FixPlan:
        if report.stale:
            return _rejected(report, revision, "content-hash-mismatch")
        if fixing_count >= 1:
            return _rejected(report, revision, "fixing-limit")
        actionable = [issue for issue in report.issues if issue.actionable]
        if not actionable:
            return _rejected(report, revision, "no-actionable-issue")
        if any(issue.suggested_action not in ALLOWED_ACTIONS for issue in actionable):
            return _rejected(report, revision, "action-not-allowed")
        if any(_unsafe_parameters(issue.parameters) for issue in actionable):
            return _rejected(report, revision, "unsafe-command")

        commands = []
        project_blob = _blob(project)
        for issue in actionable:
            command, failure = _command(project_id, project, issue)
            if command is None:
                return _rejected(report, revision, failure or "playable-fallback-missing")
            if command.name not in ALLOWED_COMMANDS or _new_url(command.payload, project_blob):
                return _rejected(report, revision, "unsafe-command")
            commands.append(command)
        if not commands:
            return _rejected(report, revision, "no-actionable-issue")
        return FixPlan(
            decision="approved",
            reason="approved",
            commands=commands,
            expected_revision=revision,
            estimated_cost_fen=0,
            content_hash=report.content_hash,
        )


def _command(
    project_id: str,
    project: dict[str, Any],
    issue: ReviewIssue,
) -> tuple[Any, str | None]:
    action = issue.suggested_action
    shot_id = issue.shot_id
    if action == "adjust-shot-duration":
        if not shot_id:
            return None, "playable-fallback-missing"
        current = _shot_duration(project, shot_id)
        if current is None:
            return None, "playable-fallback-missing"
        requested = issue.parameters.get("durationInFrames", current + 8)
        if isinstance(requested, bool) or not isinstance(requested, int):
            return None, "unsafe-command"
        return (
            compose_command(
                project_id,
                "shot/edit",
                {"shotId": shot_id, "durationInFrames": _clamp_duration(current, requested)},
            ),
            None,
        )
    if action == "set-camera-preset":
        preset = issue.parameters.get("presetId")
        if not shot_id or preset not in CAMERA_PRESETS:
            return None, "unsafe-command"
        payload: dict[str, Any] = {
            "target": {"type": "shot", "shotId": shot_id, "presetId": preset},
            "mode": "replace",
        }
        parameters = _camera_parameters(str(preset), issue.parameters)
        if parameters:
            payload["parameters"] = parameters
        return compose_command(project_id, "item/motion", payload), None
    if action == "adjust-item-motion":
        preset = issue.parameters.get("presetId")
        item_id = issue.parameters.get("itemId")
        if not isinstance(item_id, str) or preset not in ITEM_PRESETS:
            return None, "unsafe-command"
        if item_id not in (project.get("items") or {}):
            return None, "playable-fallback-missing"
        payload = {
            "target": {"type": "item", "itemId": item_id, "presetId": preset},
            "mode": "replace",
        }
        parameters = _item_parameters(str(preset), issue.parameters)
        if parameters:
            payload["parameters"] = parameters
        return compose_command(project_id, "item/motion", payload), None
    if action == "downgrade-level":
        return _downgrade(project_id, project, shot_id)
    if action == "restore-subtitle-visibility":
        return _restore_subtitle(project_id, project, shot_id)
    return None, "action-not-allowed"


def _downgrade(
    project_id: str,
    project: dict[str, Any],
    shot_id: str | None,
) -> tuple[Any, str | None]:
    if not shot_id:
        return None, "playable-fallback-missing"
    current = _animation_level(project, shot_id)
    target = decide_downgrade(current, "quality-failed-twice").animation_level  # type: ignore[arg-type]
    if target == current:
        return None, "playable-fallback-missing"
    if target != "L0":
        return None, "downgrade-step-unavailable"
    if not _plate_ready(project, shot_id):
        return None, "playable-fallback-missing"
    return compose_command(project_id, "layers/restore-l0", {"shotId": shot_id}), None


def _restore_subtitle(
    project_id: str,
    project: dict[str, Any],
    shot_id: str | None,
) -> tuple[Any, str | None]:
    if not shot_id:
        return None, "playable-fallback-missing"
    lines = []
    for item in (project.get("items") or {}).values():
        if not isinstance(item, dict) or item.get("type") != "captions":
            continue
        if item.get("shotId") != shot_id or item.get("visible") is not False:
            continue
        text = item.get("text")
        if not isinstance(text, str):
            return None, "unsafe-command"
        lines.append(
            {
                "lineId": item.get("lineId") or item["id"],
                "shotId": shot_id,
                "text": text,
                "from": int(item["from"]),
                "durationInFrames": int(item["durationInFrames"]),
                "visible": True,
            }
        )
    if not lines:
        return None, "playable-fallback-missing"
    lines.sort(key=lambda line: (int(line["from"]), str(line["lineId"])))
    return compose_command(project_id, "dialogue/add", {"lines": lines}), None


def _animation_level(project: dict[str, Any], shot_id: str) -> str:
    tracks = [
        track
        for track in project.get("tracks") or []
        if isinstance(track, dict)
        and track.get("shotId") == shot_id
        and track.get("hidden") is not True
    ]
    label = " ".join(f"{track.get('id', '')} {track.get('semantic', '')}" for track in tracks)
    if any(token in label for token in ("eye-", "mouth-", ":eye", ":mouth")):
        return "L2"
    panel = f"track:{shot_id}:panel"
    extras = [
        track
        for track in tracks
        if track.get("id") != panel and track.get("semantic") not in {None, "dialogue"}
    ]
    if extras:
        return "L1"
    return "L0"


def _plate_ready(project: dict[str, Any], shot_id: str) -> bool:
    asset_id = f"asset:{shot_id}:panel"
    item_id = f"item:{shot_id}:panel"
    track_id = f"track:{shot_id}:panel"
    assets = project.get("assets") or {}
    items = project.get("items") or {}
    return (
        asset_id in assets
        and item_id in items
        and any(
            isinstance(track, dict) and track.get("id") == track_id
            for track in project.get("tracks") or []
        )
    )


def _shot_duration(project: dict[str, Any], shot_id: str) -> int | None:
    for shot in project.get("shots") or []:
        if isinstance(shot, dict) and shot.get("id") == shot_id:
            duration = shot.get("durationInFrames")
            if isinstance(duration, int) and duration > 0:
                return duration
    return None


def _clamp_duration(current: int, requested: int) -> int:
    low = max(8, current - 15)
    high = max(low, current + 30)
    return min(high, max(low, requested))


def _camera_parameters(preset: str, raw: dict[str, Any]) -> dict[str, float]:
    if preset in {"camera-push", "camera-pull"}:
        return {"scale": _clamp_number(raw.get("scale"), 1.08, 1.0, 1.2)}
    return {"distance": _clamp_number(raw.get("distance"), 80, 0, 400)}


def _item_parameters(preset: str, raw: dict[str, Any]) -> dict[str, float]:
    if preset == "breathing":
        return {"scale": _clamp_number(raw.get("scale"), 1.01, 1.0, 1.03)}
    if preset == "hair-sway":
        return {"rotation": _clamp_number(raw.get("rotation"), 2, 1, 3)}
    return {"amplitude": _clamp_number(raw.get("amplitude"), 12, 0, 40)}


def _clamp_number(value: object, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        number = default
    else:
        number = float(value)
    return min(high, max(low, number))


def _unsafe_parameters(parameters: dict[str, Any]) -> bool:
    if any(key in _FORBIDDEN_KEYS for key in parameters):
        return True
    return any(
        isinstance(value, str) and value.startswith(("http://", "https://"))
        for value in _walk(parameters)
    )


def _new_url(payload: dict[str, Any], project_blob: str) -> bool:
    for value in _walk(payload):
        remote = isinstance(value, str) and value.startswith(("http://", "https://"))
        if remote and value not in project_blob:
            return True
    return False


def _walk(value: object) -> list[object]:
    if isinstance(value, dict):
        found: list[object] = []
        for item in value.values():
            found.extend(_walk(item))
        return found
    if isinstance(value, list):
        found = []
        for item in value:
            found.extend(_walk(item))
        return found
    return [value]


def _blob(project: dict[str, Any]) -> str:
    return str(project)


def _rejected(report: ReviewReport, revision: int, reason: str) -> FixPlan:
    return FixPlan(
        decision="rejected",
        reason=reason,
        commands=[],
        expected_revision=revision,
        estimated_cost_fen=0,
        content_hash=report.content_hash,
    )
