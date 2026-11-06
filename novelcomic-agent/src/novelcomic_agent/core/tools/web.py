"""Web tools. They stay visible to the model even when no client is configured."""

from __future__ import annotations

from typing import Any

from novelcomic_agent.core.tools.base import Tool
from novelcomic_agent.security.network import validate_resolved_url, validate_url_target


class WebSearchTool(Tool):
    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return "Search the web for supporting information."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"query": {"type": "string", "minLength": 1}},
            "required": ["query"],
        }

    async def execute(self, **kwargs: Any) -> str:
        if self._client is None:
            return "Error: web_search is not configured."
        result = self._client(str(kwargs["query"]))
        if hasattr(result, "__await__"):
            result = await result
        return str(result)


class WebFetchTool(Tool):
    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    @property
    def name(self) -> str:
        return "web_fetch"

    @property
    def description(self) -> str:
        return "Fetch a web page for grounded context."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"url": {"type": "string", "minLength": 1}},
            "required": ["url"],
        }

    async def execute(self, **kwargs: Any) -> str:
        if self._client is None:
            return "Error: web_fetch is not configured."
        url = str(kwargs["url"])
        ok, error = validate_url_target(url)
        if not ok:
            return f"Error: URL validation failed: {error}"
        result = self._client(url)
        if hasattr(result, "__await__"):
            result = await result
        final_url = _final_url(result)
        if final_url is not None:
            redir_ok, redir_err = validate_resolved_url(final_url)
            if not redir_ok:
                return f"Error: Redirect blocked: {redir_err}"
        return _body(result)


def _final_url(result: Any) -> str | None:
    if isinstance(result, (str, bytes)):
        return None
    if isinstance(result, dict):
        final = result.get("final_url", result.get("finalUrl"))
        return str(final) if final else None
    final = getattr(result, "url", None)
    return str(final) if final else None


def _body(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        body = result.get("text", result.get("content", ""))
        return body if isinstance(body, str) else str(body)
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text
    return str(result)
