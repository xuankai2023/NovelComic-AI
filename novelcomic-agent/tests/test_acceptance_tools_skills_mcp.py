"""按验收顺序打通 Agent 工具、仓内 Skills、MCP 边界和产品技能目录。

这条链路从 AgentLoop 启动开始：模型实际收到的 tool definitions、参数
cast/validate/execute、Skills allowlist，以及 Publisher 用户资产不写回 Loader。
"""

from __future__ import annotations

import inspect
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.authentication import AuthenticationMiddleware

from novelcomic_agent.agents.main.profile import (
    AgentContext,
    AgentFactory,
    AgentProfile,
    _read_file_tool,
    _web_fetch_tool,
    _web_search_tool,
)
from novelcomic_agent.core.loop import AgentLoop, AgentRunInput
from novelcomic_agent.core.skills.loader import BUILTIN_SKILLS_DIR, SkillsLoader
from novelcomic_agent.core.tools.base import Tool
from novelcomic_agent.core.tools.mcp import MCPToolWrapper, connect_mcp_servers
from novelcomic_agent.core.tools.registry import ToolRegistry
from novelcomic_agent.core.tools.subagent import MAX_SUBAGENT_DEPTH, SubagentTool
from novelcomic_agent.session.manager import Session

REPO_ROOT = Path(__file__).resolve().parents[2]
PUBLISHER_ROOT = REPO_ROOT / "novelcomic-publisher"
DOCS_DIR = REPO_ROOT / "docs/opencreator-reference/02-执行与实时回程/05-Agent工具Skills与MCP"
if str(PUBLISHER_ROOT) not in sys.path:
    sys.path.insert(0, str(PUBLISHER_ROOT))

from app.controller.v3.agent_skills import router as agent_skills_router  # noqa: E402
from app.dao.agent_skills import AgentSkillsDao  # noqa: E402
from app.middleware.auth_middleware import (  # noqa: E402
    AuthErrorMiddleware,
    ClerkAuthenticationBackend,
)


def _check(step: int, condition: bool, detail: object) -> None:
    assert condition, f"步骤 {step:02d} 失败: {detail}"


def _definition_names(definitions: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for item in definitions:
        function = item.get("function") if isinstance(item, dict) else None
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.append(function["name"])
    return names


def _write_skill(
    root: Path,
    directory: str,
    *,
    body: str,
    frontmatter_name: str | None = None,
    always: bool = False,
    requires_env: str = "",
    description: str | None = None,
    trigger: str | None = None,
) -> None:
    skill_dir = root / directory
    skill_dir.mkdir()
    name = frontmatter_name or directory
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                f"description: {description or f'{directory} description'}",
                f"trigger: {trigger or f'use {directory}'}",
                f"always: {str(always).lower()}",
                f"requires_env: {requires_env}",
                "---",
                body,
            ]
        ),
        encoding="utf-8",
    )


def _skill_files(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {str(path.relative_to(root)) for path in root.glob("*/SKILL.md")}


class ProbeTool(Tool):
    def __init__(self, sink: list[tuple[str, Any]]) -> None:
        self.sink = sink

    @property
    def name(self) -> str:
        return "probe"

    @property
    def description(self) -> str:
        return "Record cast, validate, and execute order."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"count": {"type": "integer", "minimum": 1}},
            "required": ["count"],
        }

    def cast_params(self, params: dict[str, Any]) -> dict[str, Any]:
        self.sink.append(("cast", dict(params)))
        casted = super().cast_params(params)
        self.sink.append(("after_cast", dict(casted)))
        return casted

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        self.sink.append(("validate", dict(params)))
        errors = super().validate_params(params)
        self.sink.append(("validate_result", list(errors)))
        return errors

    async def execute(self, **kwargs: Any) -> str:
        self.sink.append(("execute", dict(kwargs)))
        return "probe-ok"


class MarkerTool(Tool):
    @property
    def name(self) -> str:
        return "marker_only_on_first"

    @property
    def description(self) -> str:
        return "Exists only on one registry instance."

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> str:
        return "marker"


class ScriptedLlm:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **payload: Any) -> dict[str, Any]:
        self.calls.append(payload)
        if not self.responses:
            raise AssertionError("脚本化 LLM 被多调用了一次")
        return self.responses.pop(0)


class MemorySessionManager:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}

    async def get_or_create(
        self,
        session_id: str,
        user_id: str = "",
        workflow_id: str | None = None,
        channel: str = "api",
    ) -> Session:
        session = self.sessions.get(session_id)
        if session is None:
            session = Session(
                session_id=session_id,
                user_id=user_id,
                workflow_id=workflow_id,
                channel=channel,
            )
            self.sessions[session_id] = session
        return session

    async def save(self, session: Session, tool_traces: list[dict[str, Any]] | None = None) -> None:
        self.sessions[session.session_id] = session


class MemoryRunStore:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    async def mark_status(self, run_id: str, status: str) -> None:
        return None

    async def is_run_cancel_requested(self, run_id: str) -> bool:
        return False

    async def is_request_cancelled(
        self,
        *,
        user_id: str,
        session_id: str,
        client_request_id: str,
    ) -> bool:
        return False

    async def append_event(self, run_id: str, event: str, data: dict[str, Any]) -> str:
        self.events.append((run_id, event, data))
        return f"{len(self.events)}-0"


class BuildSpy:
    def __init__(self, inner: AgentFactory) -> None:
        self.inner = inner
        self.calls: list[tuple[str, int]] = []

    def build(self, ctx: AgentContext, name: str = "main", depth: int = 0) -> Any:
        self.calls.append((name, depth))
        return self.inner.build(ctx, name, depth)


class ClosableSession:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class MockMcpSession:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.listed = False

    async def list_tools(self) -> list[dict[str, Any]]:
        self.listed = True
        return [
            {
                "name": "ping",
                "description": "Ping the mock server.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"n": {"type": "integer", "minimum": 1}},
                    "required": ["n"],
                },
            }
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        self.calls.append((name, dict(arguments)))
        if self.fail:
            raise RuntimeError(f"{name} failed")
        return f"{name}:{arguments['n']}"


class FakeCursor:
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        self.documents = documents

    def __aiter__(self) -> FakeCursor:
        return self

    async def __anext__(self) -> dict[str, Any]:
        if not self.documents:
            raise StopAsyncIteration
        return self.documents.pop(0)


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        return all(document.get(key) == expected for key, expected in query.items())

    def find(self, query: dict[str, Any]) -> FakeCursor:
        return FakeCursor(
            [deepcopy(document) for document in self.docs if self._matches(document, query)]
        )

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def insert_one(self, document: dict[str, Any]) -> SimpleNamespace:
        self.docs.append(deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("_id"))

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        for document in self.docs:
            if self._matches(document, query):
                document.update(deepcopy(update.get("$set", {})))
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


def _run_input(session_id: str, message: str) -> AgentRunInput:
    return AgentRunInput(
        user_id="user-a",
        session_id=session_id,
        run_id=f"run-{session_id}",
        flow_id="flow-accept",
        message=message,
        client_request_id=f"req-{session_id}",
        profile_name="main",
    )


async def _run_loop(
    factory: AgentFactory,
    llm: ScriptedLlm,
    session_id: str,
    message: str,
    *,
    mcp_servers: list[Any] | None = None,
    mcp_stack: list[Any] | None = None,
) -> tuple[AgentLoop, Any]:
    loop = AgentLoop(
        session_manager=MemorySessionManager(),
        run_store=MemoryRunStore(),
        llm_client=llm,
        agent_factory=factory,
    )
    if mcp_servers is not None:
        loop._mcp_servers = mcp_servers
    if mcp_stack is not None:
        loop._mcp_stack.extend(mcp_stack)
    result = await loop.run(_run_input(session_id, message))
    return loop, result


@pytest.mark.asyncio
async def test_agent_tools_skills_mcp_product_chain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ACCEPT_SKILL_ENV", "1")
    monkeypatch.delenv("MISSING_ACCEPT_ENV", raising=False)
    _write_skill(
        tmp_path,
        "planning-core",
        body="ALWAYS_READY_BODY",
        always=True,
        requires_env="ACCEPT_SKILL_ENV",
        description="Plan before editing.",
        trigger="when a plan is requested",
    )
    _write_skill(
        tmp_path,
        "workflow-core",
        body="ON_DEMAND_BODY",
        description="Operate the workflow.",
        trigger="when the workflow should change",
    )
    _write_skill(
        tmp_path,
        "blocked-always",
        body="BLOCKED_ALWAYS_BODY",
        always=True,
        requires_env="MISSING_ACCEPT_ENV",
    )
    _write_skill(tmp_path, "secret-skill", body="SECRET_BODY", description="hidden skill")
    _write_skill(tmp_path, "bad-dir", body="MISMATCH_BODY", frontmatter_name="other-name")

    probe_sink: list[tuple[str, Any]] = []
    loader = SkillsLoader(tmp_path)
    loaded_names = {skill.name for skill in loader.list_skills()}
    _check(
        6,
        loaded_names == {"planning-core", "workflow-core", "blocked-always", "secret-skill"},
        loaded_names,
    )
    _check(
        6,
        any("does not match" in item.reason for item in loader.rejected),
        [item.reason for item in loader.rejected],
    )
    _check(
        6,
        "other-name" not in loaded_names and "MISMATCH_BODY" not in loader.load_skill("other-name"),
        loader.rejected,
    )

    def probe_factory(_ctx: AgentContext) -> ProbeTool:
        return ProbeTool(probe_sink)

    factory = AgentFactory(
        profiles={
            "main": AgentProfile(
                name="main",
                description="acceptance main",
                system_prompt="BASE_PROMPT",
                tool_factories=(
                    _read_file_tool,
                    _web_search_tool,
                    _web_fetch_tool,
                    probe_factory,
                ),
                loadable_skills=("workflow-core", "planning-core", "blocked-always"),
            ),
            "research": AgentProfile(
                name="research",
                description="acceptance child",
                system_prompt="RESEARCH_PROMPT",
                tool_factories=(_read_file_tool, _web_search_tool),
            ),
        },
        skills_loader=loader,
    )
    limited_factory = AgentFactory(
        profiles={
            "main": AgentProfile(
                name="main",
                description="limited",
                system_prompt="LIMITED_PROMPT",
                tool_factories=(_read_file_tool, _web_search_tool),
            )
        },
        skills_loader=loader,
    )

    context = AgentContext(user_id="user-a", workspace=str(tmp_path))
    first_registry = factory.build(context, "main")
    second_registry = factory.build(context, "main")
    _check(3, first_registry.tools is not second_registry.tools, "两次 build 复用了同一个 Registry")
    first_registry.tools.register(MarkerTool())
    _check(3, first_registry.tools.has("marker_only_on_first"), first_registry.tools.tool_names)
    _check(
        3, not second_registry.tools.has("marker_only_on_first"), second_registry.tools.tool_names
    )

    async def trap_connect() -> None:
        raise AssertionError("主循环不应连接 MCP server")

    trap_session = MockMcpSession()
    closable = ClosableSession()
    main_llm = ScriptedLlm(
        [
            {
                "content": "",
                "tool_calls": [
                    {"id": "call-probe", "name": "probe", "arguments": {"count": "2"}},
                    {"id": "call-bad", "name": "probe", "arguments": {}},
                    {
                        "id": "call-skill",
                        "name": "load_skill",
                        "arguments": {"name": "workflow-core"},
                    },
                    {
                        "id": "call-secret",
                        "name": "load_skill",
                        "arguments": {"name": "secret-skill"},
                    },
                    {
                        "id": "call-blocked",
                        "name": "load_skill",
                        "arguments": {"name": "blocked-always"},
                    },
                ],
            },
            {"content": "验收完成", "tool_calls": []},
        ]
    )
    main_loop, main_result = await _run_loop(
        factory,
        main_llm,
        "session-main",
        "按验收调用工具",
        mcp_servers=[{"name": "trap", "connect": trap_connect, "session": trap_session}],
        mcp_stack=[closable],
    )
    _check(
        1, main_result.status == "complete" and main_result.final_content == "验收完成", main_result
    )
    _check(1, len(main_llm.calls) == 2, main_llm.calls)
    main_tools = main_llm.calls[0]["tools"]
    main_names = _definition_names(main_tools)
    for required in ("read_file", "web_search", "web_fetch", "probe", "load_skill", "subagent"):
        _check(1, required in main_names, main_names)
    _check(1, all(item.get("type") == "function" for item in main_tools), main_tools)
    _check(
        2, "run_workflow" not in main_names and "marker_only_on_first" not in main_names, main_names
    )
    _check(11, not trap_session.listed, "主循环列出了 MCP 工具")
    _check(11, not any(name.startswith("mcp_") for name in main_names), main_names)
    _check(11, closable.closed is True and main_loop._mcp_stack == [], main_loop._mcp_stack)
    _check(11, main_loop._mcp_connected is False, main_loop._mcp_connected)

    system_prompt = main_llm.calls[0]["messages"][0]["content"]
    _check(
        8, "BASE_PROMPT" in system_prompt and "ALWAYS_READY_BODY" in system_prompt, system_prompt
    )
    _check(8, "BLOCKED_ALWAYS_BODY" not in system_prompt, system_prompt)
    _check(9, "ON_DEMAND_BODY" not in system_prompt, system_prompt)
    _check(
        9,
        "- workflow-core: Operate the workflow. Trigger: when the workflow should change"
        in system_prompt,
        system_prompt,
    )
    _check(
        7, "secret-skill" not in system_prompt and "SECRET_BODY" not in system_prompt, system_prompt
    )
    _check(6, "MISMATCH_BODY" not in system_prompt, system_prompt)

    _check(
        4,
        probe_sink[:5]
        == [
            ("cast", {"count": "2"}),
            ("after_cast", {"count": 2}),
            ("validate", {"count": 2}),
            ("validate_result", []),
            ("execute", {"count": 2}),
        ],
        probe_sink,
    )
    _check(
        5,
        [item for item in probe_sink if item[0] == "execute"] == [("execute", {"count": 2})],
        probe_sink,
    )
    _check(5, probe_sink[5:8] == [("cast", {}), ("after_cast", {}), ("validate", {})], probe_sink)
    _check(5, probe_sink[8][0] == "validate_result" and probe_sink[8][1], probe_sink)

    by_id = {
        message.get("tool_call_id"): message["content"]
        for message in main_llm.calls[1]["messages"]
        if message.get("role") == "tool"
    }
    _check(4, by_id["call-probe"] == "probe-ok", by_id["call-probe"])
    _check(
        5,
        "Invalid parameters" in by_id["call-bad"] and "probe-ok" not in by_id["call-bad"],
        by_id["call-bad"],
    )
    _check(
        9, "ON_DEMAND_BODY" in by_id["call-skill"] and "ON_DEMAND_BODY" not in system_prompt, by_id
    )
    _check(7, str(by_id["call-secret"]).startswith("Error:"), by_id["call-secret"])
    _check(8, str(by_id["call-blocked"]).startswith("Error:"), by_id["call-blocked"])
    _check(7, "SECRET_BODY" not in str(by_id["call-secret"]), by_id["call-secret"])

    limited_llm = ScriptedLlm([{"content": "limited-ok", "tool_calls": []}])
    _limited_loop, limited_result = await _run_loop(
        limited_factory,
        limited_llm,
        "session-limited",
        "只使用已声明工具",
    )
    limited_names = _definition_names(limited_llm.calls[0]["tools"])
    _check(2, limited_result.final_content == "limited-ok", limited_result)
    _check(2, limited_names == ["read_file", "web_search"], limited_names)
    _check(2, "web_fetch" not in limited_names and "load_skill" not in limited_names, limited_names)
    _check(2, "subagent" not in limited_names and "probe" not in limited_names, limited_names)

    child_llm = ScriptedLlm([{"content": "child-done", "tool_calls": []}])
    child_context = AgentContext(user_id="user-a", workspace=str(tmp_path), llm_client=child_llm)
    depth_two = factory.build(child_context, "main", depth=2)
    _check(10, depth_two.tools.has("subagent"), depth_two.tools.tool_names)
    child_text = await depth_two.tools.execute("subagent", {"task": "lookup"})
    _check(10, child_text == "child-done", child_text)
    child_names = _definition_names(child_llm.calls[0]["tools"])
    _check(10, "subagent" not in child_names, child_names)
    depth_three = factory.build(child_context, "research", depth=MAX_SUBAGENT_DEPTH)
    _check(10, not depth_three.tools.has("subagent"), depth_three.tools.tool_names)
    spy = BuildSpy(factory)
    blocked = await SubagentTool(spy, depth=MAX_SUBAGENT_DEPTH).execute(task="继续下钻")
    _check(10, "depth limit" in str(blocked) and spy.calls == [], (blocked, spy.calls))

    mock_session = MockMcpSession()
    mcp_registry = ToolRegistry()
    stack: list[Any] = []
    await connect_mcp_servers(
        [{"name": "demo", "session": mock_session, "enabled_tools": ["ping"]}],
        mcp_registry,
        stack,
    )
    wrapped = await mcp_registry.execute("mcp_demo_ping", {"n": "4"})
    _check(11, mcp_registry.has("mcp_demo_ping"), mcp_registry.tool_names)
    _check(
        11,
        wrapped == "ping:4" and mock_session.calls == [("ping", {"n": 4})],
        (wrapped, mock_session.calls),
    )
    failed = await MCPToolWrapper(
        "demo",
        {"name": "ping", "description": "ping"},
        MockMcpSession(fail=True),
    ).execute()
    _check(11, str(failed).startswith("Error executing"), failed)
    _check(
        11,
        "connect_mcp_servers" not in inspect.getsource(AgentLoop._connect_mcp),
        inspect.getsource(AgentLoop._connect_mcp),
    )

    builtin_before = _skill_files(BUILTIN_SKILLS_DIR)
    workspace_before = _skill_files(tmp_path)
    database = FakeDatabase()
    await database["user_assets"].insert_one(
        {"user_id": "user-a", "url": "https://assets.test/a-cover.png"}
    )
    app = FastAPI()
    app.add_middleware(AuthenticationMiddleware, backend=ClerkAuthenticationBackend())
    app.add_middleware(AuthErrorMiddleware)
    app.include_router(agent_skills_router, prefix="/api/v3/agent-skills")
    app.state.connections = SimpleNamespace(mongo={"novelcomic": database})
    openapi_paths = app.openapi()["paths"]
    for path, method in (
        ("/api/v3/agent-skills/personal", "get"),
        ("/api/v3/agent-skills/generate-draft", "post"),
        ("/api/v3/agent-skills", "post"),
        ("/api/v3/agent-skills/personal/{skill_id}", "patch"),
        ("/api/v3/agent-skills/personal/{skill_id}", "delete"),
    ):
        _check(15, method in openapi_paths.get(path, {}), openapi_paths)

    async def payload_for_token(token: str) -> dict[str, str]:
        return {"sub": token, "email": f"{token}@example.com"}

    with (
        TestClient(app) as client,
        patch(
            "app.middleware.auth_middleware.JwtService.get_payload_with_backoff",
            new=AsyncMock(side_effect=payload_for_token),
        ),
        patch(
            "app.controller.v3.agent_skills.get_settings",
            return_value=SimpleNamespace(mongo_database="novelcomic"),
        ),
    ):
        anonymous = client.get("/api/v3/agent-skills/personal")
        _check(12, anonymous.status_code == 401, anonymous.text)
        draft = client.post(
            "/api/v3/agent-skills/generate-draft",
            headers={"Authorization": "Bearer user-a"},
            json={"source_type": "prompt", "original_prompt": "第一幕。第二幕"},
        )
        _check(12, draft.status_code == 200, draft.text)
        _check(14, database["agent_skills"].docs == [], "草稿写入了产品技能表")
        created = client.post(
            "/api/v3/agent-skills",
            headers={"Authorization": "Bearer user-a"},
            json={
                "title": "product-skill-asset",
                "description": "用户资产，不是运行时技能",
                "cover_url": "https://assets.test/a-cover.png",
                "original_prompt": "保持原文",
                "scenes": ["第一幕", "第一幕"],
                "ai_tags": ["asset"],
                "source_type": "prompt",
            },
        )
        _check(12, created.status_code == 201, created.text)
        skill_id = created.json()["data"]["skill_id"]
        _check(12, created.json()["data"]["user_id"] == "user-a", created.text)
        listed = client.get(
            "/api/v3/agent-skills/personal",
            headers={"Authorization": "Bearer user-a"},
        )
        _check(12, listed.status_code == 200 and listed.json()["data"]["total"] == 1, listed.text)
        updated = client.patch(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"Authorization": "Bearer user-a"},
            json={"title": "product-skill-asset-updated"},
        )
        _check(
            12,
            updated.status_code == 200
            and updated.json()["data"]["title"] == "product-skill-asset-updated",
            updated.text,
        )

        hidden = client.get(
            "/api/v3/agent-skills/personal?query_text=product-skill-asset",
            headers={"Authorization": "Bearer user-b"},
        )
        _check(13, hidden.status_code == 200 and hidden.json()["data"]["skills"] == [], hidden.text)
        foreign_record = await AgentSkillsDao.get_personal(database, "user-b", skill_id)
        _check(13, foreign_record is None, foreign_record)
        foreign_update = client.patch(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"Authorization": "Bearer user-b"},
            json={"title": "偷改"},
        )
        foreign_delete = client.delete(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"Authorization": "Bearer user-b"},
        )
        _check(
            13,
            foreign_update.status_code == 404 and foreign_delete.status_code == 404,
            (foreign_update.text, foreign_delete.text),
        )
        owned_record = await AgentSkillsDao.get_personal(database, "user-a", skill_id)
        _check(
            13,
            owned_record is not None and owned_record["title"] == "product-skill-asset-updated",
            owned_record,
        )

        loader.reload()
        reloaded_names = {skill.name for skill in loader.list_skills()}
        _check(14, "product-skill-asset" not in reloaded_names, reloaded_names)
        _check(14, "product-skill-asset-updated" not in reloaded_names, reloaded_names)
        runtime_after_product = factory.build(context, "main")
        leaked = await runtime_after_product.tools.execute(
            "load_skill", {"name": "product-skill-asset-updated"}
        )
        _check(14, str(leaked).startswith("Error:"), leaked)
        _check(
            14,
            _skill_files(BUILTIN_SKILLS_DIR) == builtin_before,
            (_skill_files(BUILTIN_SKILLS_DIR), builtin_before),
        )
        _check(
            14,
            _skill_files(tmp_path) == workspace_before,
            (_skill_files(tmp_path), workspace_before),
        )
        _check(
            14,
            "product-skill-asset-updated" not in runtime_after_product.system_prompt,
            runtime_after_product.system_prompt,
        )

        deleted = client.delete(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"Authorization": "Bearer user-a"},
        )
        _check(
            12,
            deleted.status_code == 200 and deleted.json()["data"]["deleted"] is True,
            deleted.text,
        )
        after_delete = client.get(
            "/api/v3/agent-skills/personal",
            headers={"Authorization": "Bearer user-a"},
        )
        _check(12, after_delete.json()["data"]["skills"] == [], after_delete.text)

    summary = (DOCS_DIR / "总结.md").read_text(encoding="utf-8")
    order = (DOCS_DIR / "02.文件编写顺序.md").read_text(encoding="utf-8")
    question = (DOCS_DIR / "question.md").read_text(encoding="utf-8")
    principle = (DOCS_DIR / "01-Agent工具Skills与MCP.md").read_text(encoding="utf-8")
    loop_source = inspect.getsource(AgentLoop._connect_mcp)
    _check(15, "适配层存在，动态注册未启用" in summary, "总结.md 没有保留未启用口径")
    _check(15, "动态注册未启用" in order, "文件编写顺序没有保留未启用口径")
    _check(
        15,
        "_connect_mcp()" in principle and "直接返回" in principle,
        "原理文档没有写明主循环直接返回",
    )
    _check(15, "动态注册未启用" in question, question)
    _check(15, "dynamic registration stays disabled" in loop_source, loop_source)
    _check(15, "connect_mcp_servers" not in loop_source, loop_source)
    for text in (summary, question):
        _check(15, "MCP 适配层也还没写" not in text, text)
        _check(15, "还没有 `Tool` 基类" not in text, text)
        _check(15, "Publisher 还没有 `/api/v3/agent-skills`" not in text, text)
    _check(15, "mcp_" not in "".join(main_names), main_names)
