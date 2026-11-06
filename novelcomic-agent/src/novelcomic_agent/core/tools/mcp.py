"""MCP tool adapter. The main loop keeps dynamic registration disabled for now."""

from __future__ import annotations

import asyncio
import inspect
from contextlib import AsyncExitStack
from typing import Any

from novelcomic_agent.core.tools.base import Tool
from novelcomic_agent.core.tools.registry import ToolRegistry


class MCPToolWrapper(Tool):
    """Wrap one MCP tool as ``mcp_{server}_{tool}``."""

    def __init__(
        self,
        server_name: str,
        tool_def: dict[str, Any],
        session: Any,
        *,
        timeout: float = 30,
    ) -> None:
        self._server_name = server_name
        self._tool_name = str(_get_field(tool_def, "name") or "")
        self._description = str(_get_field(tool_def, "description") or self._tool_name)
        raw_schema = (
            _get_field(tool_def, "inputSchema") or _get_field(tool_def, "parameters") or {}
        )
        self._parameters = normalize_schema(raw_schema)
        self._session = session
        self._timeout = timeout

    @property
    def name(self) -> str:
        return f"mcp_{self._server_name}_{self._tool_name}"

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        try:
            result = await asyncio.wait_for(
                _call_session_tool(self._session, self._tool_name, kwargs),
                timeout=self._timeout,
            )
        except TimeoutError:
            return f"Error executing {self.name}: timed out"
        except Exception as exc:
            return f"Error executing {self.name}: {exc}"
        return _stringify_mcp_result(result)


def normalize_schema(schema: Any) -> dict[str, Any]:
    """Flatten nullable unions and fill missing object fields recursively."""

    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}, "required": []}
    normalized = dict(schema)

    raw_type = normalized.get("type")
    if isinstance(raw_type, list):
        non_null = [item for item in raw_type if item != "null"]
        if "null" in raw_type and len(non_null) == 1:
            normalized["type"] = non_null[0]
            normalized["nullable"] = True

    for key in ("oneOf", "anyOf"):
        nullable_branch = _extract_nullable_branch(normalized.get(key))
        if nullable_branch is None:
            continue
        branch = normalize_schema(nullable_branch)
        merged = {k: v for k, v in normalized.items() if k != key}
        merged.update(branch)
        merged["nullable"] = True
        normalized = merged
        break

    properties = normalized.get("properties")
    if isinstance(properties, dict):
        normalized["properties"] = {
            name: normalize_schema(prop) if isinstance(prop, dict) else prop
            for name, prop in properties.items()
        }
    items = normalized.get("items")
    if isinstance(items, dict):
        normalized["items"] = normalize_schema(items)

    if normalized.get("type", "object") == "object":
        normalized.setdefault("properties", {})
        normalized.setdefault("required", [])
    return normalized


async def connect_mcp_servers(
    servers: list[dict[str, Any]] | dict[str, Any],
    registry: ToolRegistry,
    stack: list[Any] | AsyncExitStack,
) -> None:
    """Register wrappers for enabled MCP tools. Not called by the main loop."""

    for server_name, server in _iter_servers(servers):
        session = _get_field(server, "session")
        connect = _get_field(server, "connect")
        if session is None and callable(connect):
            session = connect()
            if hasattr(session, "__await__"):
                session = await session
        if session is None:
            session = await _connect_configured_server(server_name, server, stack)
        if session is None:
            continue
        if isinstance(stack, list):
            stack.append(session)
        enabled = _get_field(server, "enabled_tools") or _get_field(server, "enabledTools")
        tool_defs = _extract_tools(await session.list_tools())
        allow_all = enabled is None or "*" in set(enabled)
        for tool_def in tool_defs:
            tool_name = str(_get_field(tool_def, "name") or "")
            wrapped_name = f"mcp_{server_name}_{tool_name}"
            if (
                isinstance(enabled, (list, set, tuple))
                and not allow_all
                and tool_name not in enabled
                and wrapped_name not in enabled
            ):
                continue
            registry.register(
                MCPToolWrapper(
                    server_name,
                    tool_def,
                    session,
                    timeout=float(
                        _get_field(server, "timeout")
                        or _get_field(server, "tool_timeout")
                        or 30
                    ),
                )
            )


def _extract_nullable_branch(options: Any) -> dict[str, Any] | None:
    if not isinstance(options, list):
        return None
    non_null: list[dict[str, Any]] = []
    saw_null = False
    for option in options:
        if not isinstance(option, dict):
            return None
        if option.get("type") == "null":
            saw_null = True
            continue
        non_null.append(option)
    if saw_null and len(non_null) == 1:
        return non_null[0]
    return None


def _get_field(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _iter_servers(servers: list[dict[str, Any]] | dict[str, Any]) -> list[tuple[str, Any]]:
    if isinstance(servers, dict):
        return [(str(name), cfg) for name, cfg in servers.items()]
    return [
        (str(_get_field(server, "name") or "server"), server)
        for server in servers
    ]


def _extract_tools(raw: Any) -> list[Any]:
    tools = _get_field(raw, "tools")
    if isinstance(tools, list):
        return tools
    if isinstance(raw, list):
        return raw
    return []


async def _call_session_tool(session: Any, tool_name: str, kwargs: dict[str, Any]) -> Any:
    call_tool = session.call_tool
    try:
        result = call_tool(tool_name, arguments=kwargs)
    except TypeError:
        result = call_tool(tool_name, kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def _stringify_mcp_result(result: Any) -> str:
    content = _get_field(result, "content")
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            text = _get_field(block, "text")
            parts.append(str(text if text is not None else block))
        return "\n".join(parts) or "(no output)"
    if isinstance(content, str):
        return content
    return str(result)


async def _connect_configured_server(
    server_name: str,
    cfg: Any,
    stack: list[Any] | AsyncExitStack,
) -> Any:
    if not isinstance(stack, AsyncExitStack):
        return None

    command = _get_field(cfg, "command")
    url = _get_field(cfg, "url")
    transport_type = _get_field(cfg, "type")
    if not transport_type:
        if command:
            transport_type = "stdio"
        elif url:
            transport_type = "sse" if str(url).rstrip("/").endswith("/sse") else "streamableHttp"
    if not transport_type:
        return None

    from mcp import ClientSession, StdioServerParameters
    from mcp.client.sse import sse_client
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client

    if transport_type == "stdio":
        params = StdioServerParameters(
            command=command,
            args=_get_field(cfg, "args") or [],
            env=_get_field(cfg, "env") or None,
        )
        read, write = await stack.enter_async_context(stdio_client(params))
    elif transport_type == "sse":
        read, write = await stack.enter_async_context(
            sse_client(str(url), headers=_get_field(cfg, "headers") or None)
        )
    elif transport_type == "streamableHttp":
        read, write, _ = await stack.enter_async_context(
            streamable_http_client(str(url), headers=_get_field(cfg, "headers") or None)
        )
    else:
        return None

    session = await stack.enter_async_context(ClientSession(read, write))
    await session.initialize()
    return session
