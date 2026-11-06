"""Long-term memory. Disabled unless Settings.memory_enabled is true."""

from __future__ import annotations

from typing import Any

from novelcomic_agent.config import Settings


def connect_memory(settings: Settings) -> Any | None:
    if not settings.memory_enabled:
        return None
    from novelcomic_agent.core.memory.mem0_memory import Mem0Memory

    return Mem0Memory()
