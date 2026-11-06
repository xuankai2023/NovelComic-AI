"""兼容入口的删除顺序：先记账，再记调用量，最后才允许删。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

SECRET_MARKERS = ("SECRET", "TOKEN", "PASSWORD", "KEY", "DSN", "CREDENTIAL", "PEM", "COOKIE")
STAGES = ("stop_write", "change_read", "remove_fallback")
SWITCHES = {
    "ENABLE_BULL_BOARD": False,
    "CONFIG_LOADER_ENABLED": False,
    "ALERT_FEISHU_ENABLED": False,
    "MODEL_CALL_FEISHU_ENABLED": False,
    "memory_enabled": False,
    "posthog_enabled": False,
}


class CompatRetirementError(Exception):
    pass


@dataclass(frozen=True)
class CompatEntry:
    id: str
    label: str
    callers: tuple[str, ...]
    deletion_condition: str
    volume_key: str | None = None
    producer: str | None = None
    consumer: str | None = None
    keep_while_callers: bool = False


ENTRIES: dict[str, CompatEntry] = {
    entry.id: entry
    for entry in (
        CompatEntry(
            id="v1_flow",
            label="兼容",
            callers=("opencreator-publisher/controller/v1/flow.py",),
            deletion_condition="停止写入旧 flow 格式，改读路径，去掉 fallback，最后删 v1 flow 路由",
            volume_key="v1_flow",
            producer="publisher",
            consumer="consumer",
        ),
        CompatEntry(
            id="legacy_agent_chat",
            label="未启用",
            callers=("POST /v1/agent/chat", "POST /api/v1/agent/chat/stop"),
            deletion_condition="调用量归零并且客户端改走 /v1/agent/runs 之后，才能删 410 路由",
            volume_key="legacy_agent_chat",
        ),
        CompatEntry(
            id="legacy_model_id",
            label="兼容",
            callers=("OpenCreatorAIModelMapper.to_opencreator_model_id",),
            deletion_condition="停止写入旧 model id，读路径改为 opencreator/ 前缀，去掉映射 fallback 之后才能删表",
            volume_key="legacy_model_id",
            producer="consumer",
            consumer="ai",
        ),
        CompatEntry(
            id="payments_deprecated",
            label="兼容",
            callers=(
                "dao/payments.py save_payments",
                "dao/payments.py get_payments_history_page",
            ),
            deletion_condition="调用方还在时保持原函数",
            keep_while_callers=True,
        ),
    )
}


def config_dump(values: Mapping[str, object]) -> dict[str, bool]:
    """开关写成开或关。密钥、令牌和连接串不进入这份结果。"""

    dumped: dict[str, bool] = {}
    for name, value in values.items():
        upper = name.upper()
        if any(marker in upper for marker in SECRET_MARKERS):
            continue
        if isinstance(value, bool):
            dumped[name] = value
    for name, default in SWITCHES.items():
        dumped.setdefault(name, default)
    return dumped


def advance(progress: list[str], stage: str) -> list[str]:
    if stage not in STAGES:
        raise CompatRetirementError(f"未知阶段 {stage}")
    expected = STAGES[len(progress)] if len(progress) < len(STAGES) else None
    if stage != expected:
        raise CompatRetirementError(f"下一步应是 {expected or '删除'}")
    return [*progress, stage]


def revision_sides(manifest: Mapping[str, object] | None, producer: str, consumer: str) -> dict:
    if not isinstance(manifest, dict):
        raise CompatRetirementError("跨仓删除要用同一份 revision manifest")
    sides = {}
    for role, tree in (("producer", producer), ("consumer", consumer)):
        node = manifest.get(tree)
        sha = node.get("new") if isinstance(node, dict) else None
        if not isinstance(sha, str) or not sha:
            raise CompatRetirementError(f"revision manifest 缺少 {tree}")
        sides[role] = {"tree": tree, "sha": sha}
    return sides


def plan_delete(
    entry_id: str,
    *,
    volume: int = 0,
    progress: list[str] | None = None,
    manifest: Mapping[str, object] | None = None,
    live_callers: list[str] | None = None,
    source: str | None = None,
) -> dict[str, object]:
    entry = ENTRIES[entry_id]
    if not entry.label or not entry.callers or not entry.deletion_condition:
        raise CompatRetirementError("先写下标签、调用方和删除条件")
    callers_now = entry.callers if live_callers is None else tuple(live_callers)
    if entry.keep_while_callers and callers_now:
        if source is None:
            raise CompatRetirementError("调用方还在，保持原函数")
        return {
            "deleted": False,
            "id": entry_id,
            "source": source,
            "reason": "调用方还在，保持原函数",
        }
    if entry.volume_key is not None and volume > 0:
        raise CompatRetirementError("还有调用量，不能删")
    done = progress or []
    if tuple(done) != STAGES:
        raise CompatRetirementError("先停止写入，再改读路径，去掉 fallback，最后才能删")
    sides = None
    if entry.producer and entry.consumer:
        sides = revision_sides(manifest, entry.producer, entry.consumer)
    return {"deleted": True, "id": entry_id, "sides": sides}


def find_python_callers(root: Path, name: str, definition: Path | None = None) -> list[str]:
    needle = f"{name}("
    definition_path = definition.resolve() if definition else None
    matches: list[str] = []
    for path in sorted(root.rglob("*.py")):
        if definition_path is not None and path.resolve() == definition_path:
            continue
        if needle in path.read_text(encoding="utf-8"):
            matches.append(str(path.relative_to(root)))
    return matches
