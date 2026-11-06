"""Instance-scoped tool registry. A new registry is created for every agent build."""

from __future__ import annotations

import logging
from typing import Any

from novelcomic_agent.core.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)
_HINT = "\n\n[Analyze the error above and try a different approach.]"


class ToolRegistry:
    """Look up, describe, and execute tools for one agent instance."""

    def __init__(self) -> None:
        self._tools: dict[str, Any] = {}

    def register(self, tool: Any) -> None:
        name = getattr(tool, "name", None)
        if not isinstance(name, str) or not name:
            raise ValueError("tool must have a name")
        self._tools[name] = tool

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def get(self, name: str) -> Any | None:
        return self._tools.get(name)

    def has(self, name: str) -> bool:
        return name in self._tools

    def get_definitions(self, *, exclude: set[str] | None = None) -> list[dict[str, Any]]:
        definitions: list[dict[str, Any]] = []
        for name, tool in self._tools.items():
            if exclude and name in exclude:
                continue
            if isinstance(tool, Tool):
                definitions.append(tool.to_schema())
                continue
            parameters = getattr(tool, "parameters", None) or getattr(
                tool, "input_schema", {"type": "object", "properties": {}}
            )
            definitions.append(
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": getattr(tool, "description", ""),
                        "parameters": parameters,
                    },
                }
            )
        return definitions

    async def execute(self, name: str, params: dict[str, Any]) -> str | ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            return f"Error: Tool '{name}' not found. Available: {', '.join(self.tool_names)}"
        if not isinstance(tool, Tool):
            return f"Error: Tool '{name}' is not a schema-backed tool."
        try:
            cast_params = tool.cast_params(params or {})
            errors = tool.validate_params(cast_params)
            if errors:
                return f"Error: Invalid parameters for tool '{name}': " + "; ".join(errors) + _HINT
            result = await tool.execute(**cast_params)
        except Exception as exc:
            logger.exception("tool execution failed: %s", name)
            return f"Error executing {name}: {exc}" + _HINT
        if isinstance(result, ToolResult):
            if result.content.startswith("Error"):
                result.content += _HINT
            return result
        if isinstance(result, str) and result.startswith("Error"):
            return result + _HINT
        return result

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())

    def values(self) -> list[Any]:
        return list(self._tools.values())

    def __setitem__(self, name: str, tool: Any) -> None:
        self._tools[name] = tool

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tools

    def __len__(self) -> int:
        return len(self._tools)

    def __iter__(self):
        return iter(self._tools.values())
