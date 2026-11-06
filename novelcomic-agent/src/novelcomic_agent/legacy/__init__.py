"""旧 Agent chat 的调用量。410 响应保持不变。"""

from __future__ import annotations

_COUNTS = {"legacy_agent_chat": 0}


def reset_legacy_call_volume() -> None:
    _COUNTS["legacy_agent_chat"] = 0


def legacy_call_volume() -> dict[str, int]:
    return dict(_COUNTS)


def note_legacy_agent_chat() -> None:
    _COUNTS["legacy_agent_chat"] += 1
