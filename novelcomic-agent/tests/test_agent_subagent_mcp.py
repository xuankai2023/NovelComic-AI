from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from novelcomic_agent.agents.main.profile import (
    PROFILE,
    RESEARCH_PROFILE,
    AgentContext,
    AgentFactory,
)
from novelcomic_agent.core.loop import AgentLoop
from novelcomic_agent.core.tools.mcp import MCPToolWrapper, connect_mcp_servers, normalize_schema
from novelcomic_agent.core.tools.registry import ToolRegistry


class SequencedLlm:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **payload: Any) -> dict[str, Any]:
        self.calls.append(payload)
        return self.responses.pop(0)


def _factory_without_loadable_skills() -> AgentFactory:
    return AgentFactory(
        profiles={
            "main": replace(PROFILE, loadable_skills=()),
            "research": replace(RESEARCH_PROFILE, loadable_skills=()),
        }
    )


async def test_subagent_runs_child_profile_and_child_tools(tmp_path: Path) -> None:
    (tmp_path / "story.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    llm = SequencedLlm(
        [
            {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-read",
                        "name": "read_file",
                        "arguments": {"path": "story.txt"},
                    }
                ],
            },
            {"content": "child saw alpha", "tool_calls": []},
        ]
    )
    factory = _factory_without_loadable_skills()
    runtime = factory.build(
        AgentContext(workspace=str(tmp_path), llm_client=llm),
        name="main",
    )

    result = await runtime.tools.get("subagent").execute(task="read story.txt")

    assert result == "child saw alpha"
    assert len(llm.calls) == 2
    assert llm.calls[0]["messages"][0]["role"] == "system"
    assert any(
        message.get("role") == "tool" and "alpha" in message.get("content", "")
        for message in llm.calls[1]["messages"]
    )


async def test_subagent_depth_three_builds_child_without_more_subagents(tmp_path: Path) -> None:
    llm = SequencedLlm([{"content": "done", "tool_calls": []}])
    factory = _factory_without_loadable_skills()
    runtime = factory.build(
        AgentContext(workspace=str(tmp_path), llm_client=llm),
        name="main",
        depth=2,
    )

    assert runtime.tools.has("subagent")
    assert await runtime.tools.get("subagent").execute(task="delegate once") == "done"
    exposed_tool_names = {
        tool["function"]["name"]
        for tool in llm.calls[0]["tools"]
    }
    assert "subagent" not in exposed_tool_names
    assert not factory.build(
        AgentContext(workspace=str(tmp_path), llm_client=llm),
        name="research",
        depth=3,
    ).tools.has("subagent")


def test_normalize_schema_handles_nullable_unions_recursively() -> None:
    schema = normalize_schema(
        {
            "type": "object",
            "properties": {
                "title": {"type": ["string", "null"]},
                "count": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                "items": {
                    "type": "array",
                    "items": {"oneOf": [{"type": "null"}, {"type": "string"}]},
                },
            },
        }
    )

    assert schema["required"] == []
    assert schema["properties"]["title"] == {"type": "string", "nullable": True}
    assert schema["properties"]["count"]["type"] == "integer"
    assert schema["properties"]["count"]["nullable"] is True
    assert schema["properties"]["items"]["items"] == {
        "type": "string",
        "nullable": True,
    }


@dataclass
class TextBlock:
    text: str


@dataclass
class ToolResponse:
    content: list[TextBlock]


class MockMcpSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def list_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "echo",
                "description": "Echo text",
                "inputSchema": {
                    "type": "object",
                    "properties": {"text": {"type": ["string", "null"]}},
                },
            },
            {"name": "skip", "inputSchema": {"type": "object"}},
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolResponse:
        self.calls.append((name, arguments))
        return ToolResponse(content=[TextBlock(text=f"{name}:{arguments['text']}")])


async def test_connect_mcp_servers_registers_enabled_mock_tools() -> None:
    session = MockMcpSession()
    registry = ToolRegistry()
    stack: list[Any] = []

    await connect_mcp_servers(
        [{"name": "local", "session": session, "enabled_tools": ["echo"]}],
        registry,
        stack,
    )

    assert stack == [session]
    assert registry.tool_names == ["mcp_local_echo"]
    assert registry.get("mcp_local_echo").parameters["properties"]["text"] == {
        "type": "string",
        "nullable": True,
    }
    assert await registry.execute("mcp_local_echo", {"text": "hello"}) == "echo:hello"
    assert session.calls == [("echo", {"text": "hello"})]


class HangingMcpSession:
    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        import asyncio

        await asyncio.sleep(1)
        return "late"


async def test_mcp_wrapper_returns_error_text_on_timeout() -> None:
    wrapper = MCPToolWrapper(
        "local",
        {"name": "slow", "inputSchema": {"type": "object"}},
        HangingMcpSession(),
        timeout=0.001,
    )

    assert await wrapper.execute() == "Error executing mcp_local_slow: timed out"


class ClosableSession:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


async def test_agent_loop_keeps_mcp_disabled_but_closes_stack() -> None:
    loop = AgentLoop(
        session_manager=object(),
        run_store=object(),
        llm_client=object(),
    )
    closable = ClosableSession()
    loop._mcp_stack.append(closable)
    loop._mcp_connected = True
    loop._mcp_connecting = True

    await loop._connect_mcp()
    assert loop._mcp_connected is True
    assert loop._mcp_connecting is True

    await loop.close_mcp()
    assert closable.closed is True
    assert loop._mcp_stack == []
    assert loop._mcp_connected is False
    assert loop._mcp_connecting is False
