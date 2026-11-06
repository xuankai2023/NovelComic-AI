"""Delegate a bounded task to a child profile."""

from __future__ import annotations

import inspect
import json
from collections.abc import Mapping
from typing import Any

from novelcomic_agent.core.tools.base import Tool, ToolResult

MAX_SUBAGENT_DEPTH = 3
MAX_SUBAGENT_ITERATIONS = 8


class SubagentTool(Tool):
    """Run a child profile through the same factory, stopping at depth 3."""

    def __init__(self, factory: Any, *, depth: int, default_profile: str = "research") -> None:
        self._factory = factory
        self._depth = depth
        self._default_profile = default_profile
        self._context: Any = None

    def bind_context(self, context: Any) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "subagent"

    @property
    def description(self) -> str:
        return "Delegate a bounded task to a child agent profile."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task": {"type": "string", "minLength": 1},
                "profile": {
                    "type": "string",
                    "description": "Child profile to run. Defaults to research.",
                },
            },
            "required": ["task"],
        }

    async def execute(self, **kwargs: Any) -> str:
        if self._depth >= MAX_SUBAGENT_DEPTH:
            return "Error: subagent depth limit reached."

        next_depth = self._depth + 1
        profile_name = str(kwargs.get("profile") or self._default_profile)
        task = str(kwargs.get("task") or "").strip()
        if not task:
            return "Error: subagent task is required."

        try:
            runtime = self._factory.build(self._context, profile_name, depth=next_depth)
        except Exception as exc:
            return f"Error: failed to build subagent '{profile_name}': {exc}"

        llm_client = getattr(runtime.context, "llm_client", None)
        if llm_client is None:
            return "Error: subagent llm_client is not configured."

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": runtime.system_prompt},
            {"role": "user", "content": task},
        ]
        max_iterations = min(
            int(runtime.max_iterations or MAX_SUBAGENT_ITERATIONS),
            MAX_SUBAGENT_ITERATIONS,
        )
        final_content = ""

        for _ in range(max_iterations):
            response = _normalize_llm_response(
                await _call_llm(
                    llm_client,
                    messages=messages,
                    tools=runtime.tools.get_definitions(),
                    model=runtime.model,
                )
            )
            content = response.get("content", "")
            tool_calls = response.get("tool_calls", [])
            if content:
                final_content += content
            if not tool_calls:
                return final_content or "(subagent produced no output)"

            messages.append(
                {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tool_calls,
                }
            )
            for raw_call in tool_calls:
                tool_call = _normalize_tool_call(raw_call)
                result = await runtime.tools.execute(tool_call["name"], tool_call["arguments"])
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call["id"],
                        "name": tool_call["name"],
                        "content": _stringify_tool_result(result),
                    }
                )

        return f"Error: subagent exceeded max_iterations={max_iterations}."


async def _call_llm(
    llm_client: Any,
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    model: str | None,
) -> Any:
    payload = {"messages": messages, "tools": tools, "model": model}
    for method_name in ("complete", "chat", "create"):
        method = getattr(llm_client, method_name, None)
        if callable(method):
            return await _maybe_await(method(**payload))
    if callable(llm_client):
        return await _maybe_await(llm_client(**payload))
    raise RuntimeError("llm_client does not expose complete/chat/create")


def _normalize_llm_response(response: Any) -> dict[str, Any]:
    if isinstance(response, str):
        return {"content": response, "tool_calls": []}
    if isinstance(response, Mapping):
        return {
            "content": str(response.get("content") or response.get("text") or ""),
            "tool_calls": list(response.get("tool_calls") or []),
        }
    content = getattr(response, "content", None) or getattr(response, "text", None) or ""
    return {
        "content": str(content),
        "tool_calls": list(getattr(response, "tool_calls", None) or []),
    }


def _normalize_tool_call(raw_call: Any) -> dict[str, Any]:
    if not isinstance(raw_call, Mapping):
        raise RuntimeError(f"invalid tool call: {raw_call!r}")
    function = raw_call.get("function")
    name = raw_call.get("name") or raw_call.get("tool_name")
    if not name and isinstance(function, Mapping):
        name = function.get("name")
    if not isinstance(name, str) or not name:
        raise RuntimeError(f"tool call missing name: {raw_call!r}")
    arguments = raw_call.get("arguments")
    if arguments is None and isinstance(function, Mapping):
        arguments = function.get("arguments")
    if isinstance(arguments, str):
        arguments = json.loads(arguments or "{}")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise RuntimeError(f"tool call arguments must be an object: {raw_call!r}")
    return {
        "id": str(raw_call.get("id") or raw_call.get("tool_call_id") or f"subagent_{name}"),
        "name": name,
        "arguments": arguments,
    }


def _stringify_tool_result(result: Any) -> str:
    if isinstance(result, ToolResult):
        if result.success:
            return result.content
        return result.error or result.content
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value
