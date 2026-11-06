"""Workspace file reading and skill loading tools."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from novelcomic_agent.core.skills.loader import SkillsLoader
from novelcomic_agent.core.tools.base import Tool


class ReadFileTool(Tool):
    """Read a text file inside the agent workspace."""

    def __init__(self, workspace: str | None) -> None:
        self._workspace = workspace

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return "Read a text file inside the current workspace."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "minLength": 1},
                "offset": {"type": "integer", "minimum": 1},
                "limit": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
        }

    async def execute(self, **kwargs: Any) -> str:
        relative_path = str(kwargs["path"])
        offset = int(kwargs.get("offset") or 1)
        limit = kwargs.get("limit")
        resolved = self._resolve(relative_path)
        if isinstance(resolved, str):
            return resolved
        lines = resolved.read_text(encoding="utf-8").splitlines()
        start = max(offset - 1, 0)
        selected = lines[start:] if limit is None else lines[start : start + int(limit)]
        return "\n".join(f"{start + index + 1}|{line}" for index, line in enumerate(selected))

    def _resolve(self, relative_path: str) -> Path | str:
        if not self._workspace:
            return "Error: read_file has no workspace configured."
        root = Path(self._workspace).resolve()
        target = (root / relative_path).resolve()
        if not target.is_relative_to(root):
            return "Error: read_file cannot read files outside the workspace."
        if not target.is_file():
            return f"Error: file not found: {relative_path}"
        return target


class LoadSkillTool(Tool):
    """Load one allowlisted skill body through the skills cache."""

    def __init__(self, skills_loader: SkillsLoader) -> None:
        self._skills = skills_loader

    @property
    def name(self) -> str:
        return "load_skill"

    @property
    def description(self) -> str:
        return "Load the full instructions for one allowlisted skill."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"name": {"type": "string", "minLength": 1}},
            "required": ["name"],
        }

    async def execute(self, **kwargs: Any) -> str:
        return self._skills.load_skill(str(kwargs["name"]))
