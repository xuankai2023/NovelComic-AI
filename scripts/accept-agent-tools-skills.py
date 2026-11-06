#!/usr/bin/env python3
"""按 Agent 工具、Skills 与 MCP 的验收顺序，打运行时分层和产品技能资产。

用法：
  novelcomic-agent/.venv/bin/python scripts/accept-agent-tools-skills.py
"""

from __future__ import annotations

import asyncio
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.authentication import AuthCredentials, AuthenticationBackend
from starlette.middleware.authentication import AuthenticationMiddleware

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "novelcomic-agent" / "src"))
sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

from app.controller.v3.agent_skills import router as agent_skills_router  # noqa: E402
from app.middleware.auth_middleware import AuthUser  # noqa: E402
from app.schemas.agent_skills import CreateAgentSkillRequest  # noqa: E402
from novelcomic_agent.agents.main.profile import (  # noqa: E402
    DEFAULT_AGENT_FACTORY,
    AgentContext,
    AgentFactory,
    AgentProfile,
    _read_file_tool,
    _web_search_tool,
)
from novelcomic_agent.core.loop import AgentLoop  # noqa: E402
from novelcomic_agent.core.skills.loader import BUILTIN_SKILLS_DIR, SkillsLoader  # noqa: E402
from novelcomic_agent.core.tools.base import Tool  # noqa: E402
from novelcomic_agent.core.tools.mcp import MCPToolWrapper, connect_mcp_servers, normalize_schema  # noqa: E402
from novelcomic_agent.core.tools.registry import ToolRegistry  # noqa: E402
from novelcomic_agent.core.tools.subagent import MAX_SUBAGENT_DEPTH, SubagentTool  # noqa: E402

_STEP_TITLES = [
    "Agent 启动后，Profile 中声明的工具会出现在 LLM tool definitions",
    "未声明的工具不会出现在当前 Agent 实例",
    "同一 Profile 连续 build 得到独立 Registry",
    "工具参数会先 cast，再 validate，再 execute",
    "参数错误不会进入工具业务逻辑",
    "SkillsLoader 能扫描仓内 SKILL.md，并拒绝目录名和 frontmatter name 不一致的 skill",
    "Profile allowlist 外的 skill 不会进入 summary，也不能被 load_skill 加载",
    "always: true 且 requirements 满足的 skill body 会进入 system prompt",
    "非 always skill 只出现在 summary，模型调用 load_skill 后才拿到完整内容",
    "SubagentTool 受深度限制，最大深度为 3",
    "MCP wrapper 能包装 mock server 工具，但当前主循环不会动态注册真实 MCP 工具",
    "Publisher Agent Skills 可以按用户增删改查",
    "A 用户不能读取、更新或删除 B 用户技能",
    "产品 Agent Skills 不会自动写入仓内 SkillsLoader",
    "文档、接口和运行时口径一致：MCP 适配存在，但动态注册未启用",
]


def _require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(str(message))


def _join(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    return f"{left}；{right}"


def _format_error(exc: Exception) -> str:
    if isinstance(exc, AssertionError):
        return str(exc) or exc.__class__.__name__
    return "".join(traceback.format_exception(exc)).strip()


def _guard(results: list[dict[str, Any]], steps: tuple[int, ...], fn: Any) -> None:
    try:
        details = fn()
    except Exception as exc:
        message = _format_error(exc)
        for step in steps:
            item = results[step - 1]
            item["ok"] = False
            item["detail"] = _join(item["detail"], message)
        return
    for step, detail in details.items():
        results[step - 1]["detail"] = _join(results[step - 1]["detail"], str(detail))


def _definition_names(runtime: Any) -> list[str]:
    names: list[str] = []
    for item in runtime.tools.get_definitions():
        function = item.get("function") if isinstance(item, dict) else None
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.append(function["name"])
    return names


class _ProbeTool(Tool):
    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []

    @property
    def name(self) -> str:
        return "probe"

    @property
    def description(self) -> str:
        return "Probe cast and validation."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"count": {"type": "integer", "minimum": 1}},
            "required": ["count"],
        }

    async def execute(self, **kwargs: Any) -> str:
        self.seen.append(dict(kwargs))
        return "ok"


class _HeaderAuth(AuthenticationBackend):
    async def authenticate(self, conn: Any) -> tuple[AuthCredentials, AuthUser] | None:
        user_id = conn.headers.get("x-user-id")
        if not user_id:
            return None
        return AuthCredentials(["authenticated"]), AuthUser(user_id=user_id)


class _Collection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(dict(document))

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    def find(self, query: dict[str, Any]) -> _Collection:
        self._matched = [
            dict(document)
            for document in self.docs
            if all(document.get(key) == value for key, value in query.items())
        ]
        return self

    def __aiter__(self) -> _Collection:
        self._iter = iter(getattr(self, "_matched", []))
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                document.update(update.get("$set") or {})
                return


class _Database:
    def __init__(self) -> None:
        self.collections: dict[str, _Collection] = {}

    def __getitem__(self, name: str) -> _Collection:
        if name not in self.collections:
            self.collections[name] = _Collection()
        return self.collections[name]


class _MockSession:
    def __init__(self, tools: list[dict[str, Any]], *, fail: bool = False, delay: float = 0) -> None:
        self._tools = tools
        self.fail = fail
        self.delay = delay
        self.closed = False

    async def list_tools(self) -> list[dict[str, Any]]:
        return list(self._tools)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError(f"{name} failed")
        return f"{name}:{arguments}"

    async def aclose(self) -> None:
        self.closed = True


def _skill_files() -> set[str]:
    return {str(path.relative_to(BUILTIN_SKILLS_DIR)) for path in BUILTIN_SKILLS_DIR.glob("*/SKILL.md")}


def _run() -> list[dict[str, Any]]:
    results = [
        {"step": index, "name": title, "ok": True, "detail": ""}
        for index, title in enumerate(_STEP_TITLES, start=1)
    ]
    context = AgentContext(user_id="user-a", workspace="/tmp/novelcomic-agent-workspace")
    runtime = DEFAULT_AGENT_FACTORY.build(context, "main")
    limited = AgentFactory(
        {
            "main": AgentProfile(
                name="main",
                description="limited",
                system_prompt="limited",
                tool_factories=(_read_file_tool, _web_search_tool),
                loadable_skills=(),
            )
        }
    ).build(context, "main")

    def check_definitions() -> dict[int, str]:
        names = _definition_names(runtime)
        for required in ("read_file", "web_search", "web_fetch", "load_skill"):
            _require(required in names, names)
        return {1: "definitions=" + ",".join(names)}

    def check_undeclared() -> dict[int, str]:
        names = _definition_names(limited)
        _require("web_fetch" not in names, names)
        _require("read_file" in names and "web_search" in names, names)
        return {2: "limited=" + ",".join(names)}

    def check_isolated_registries() -> dict[int, str]:
        first = DEFAULT_AGENT_FACTORY.build(context, "main")
        second = DEFAULT_AGENT_FACTORY.build(context, "main")
        _require(first.tools is not second.tools, "registry was reused")
        first.tools.register(_ProbeTool())
        _require(first.tools.has("probe"), first.tools.tool_names)
        _require(not second.tools.has("probe"), second.tools.tool_names)
        return {3: "两次 build 的 Registry 互不影响"}

    def check_cast_and_validate() -> dict[int, str]:
        tool = _ProbeTool()
        registry = ToolRegistry()
        registry.register(tool)

        async def _call() -> tuple[Any, Any]:
            cast_result = await registry.execute("probe", {"count": "2"})
            invalid = await registry.execute("probe", {})
            return cast_result, invalid

        cast_result, invalid = asyncio.run(_call())
        _require(tool.seen == [{"count": 2}], tool.seen)
        _require(cast_result == "ok", cast_result)
        _require("Invalid parameters" in str(invalid), invalid)
        _require(tool.seen == [{"count": 2}], tool.seen)
        return {
            4: "count='2' cast 为 2 后才 execute",
            5: "缺少 count 时 execute 没有被调用",
        }

    def check_loader() -> dict[int, str]:
        loader = SkillsLoader()
        names = {skill.name for skill in loader.list_skills()}
        _require({"planning-core", "workflow-core"} <= names, names)
        mismatched = ROOT / "novelcomic-agent" / "src" / "novelcomic_agent" / "core" / "skills"
        temp_root = mismatched.parent / "_tmp_skills_accept"
        bad_dir = temp_root / "actual-dir"
        try:
            bad_dir.mkdir(parents=True)
            (bad_dir / "SKILL.md").write_text("---\nname: other-name\ndescription: nope\n---\nBODY\n", encoding="utf-8")
            scanned = SkillsLoader(temp_root)
        finally:
            if bad_dir.exists():
                (bad_dir / "SKILL.md").unlink()
                bad_dir.rmdir()
                temp_root.rmdir()
        _require(any("does not match" in item.reason for item in scanned.rejected), scanned.rejected)
        _require("other-name" not in {skill.name for skill in scanned.list_skills()}, scanned.list_skills())
        return {6: f"loaded={sorted(names)}，name 不一致被拒绝"}

    def check_allowlist_and_prompt() -> dict[int, str]:
        prompt = runtime.system_prompt
        _require("PLANNING_CORE_BODY" in prompt, prompt)
        _require("WORKFLOW_CORE_BODY" not in prompt, prompt)
        _require("workflow-core:" in prompt, prompt)
        _require("secret-skill" not in prompt, prompt)
        secret_root = ROOT / "novelcomic-agent" / "src" / "novelcomic_agent" / "core" / "skills_secret_accept"
        secret_dir = secret_root / "secret-skill"
        try:
            secret_dir.mkdir(parents=True)
            (secret_dir / "SKILL.md").write_text(
                "---\nname: secret-skill\ndescription: hidden\ntrigger: never\n---\nSECRET_BODY\n",
                encoding="utf-8",
            )
            secret_loader = SkillsLoader(secret_root)
        finally:
            (secret_dir / "SKILL.md").unlink()
            secret_dir.rmdir()
            secret_root.rmdir()
        visible = secret_loader.filtered(["planning-core"])
        _require("secret-skill" not in visible.build_skills_summary(), visible.build_skills_summary())
        _require(visible.load_skill("secret-skill").startswith("Error:"), visible.load_skill("secret-skill"))
        loaded = asyncio.run(runtime.tools.execute("load_skill", {"name": "workflow-core"}))
        _require("WORKFLOW_CORE_BODY" in str(loaded), loaded)
        missing = asyncio.run(runtime.tools.execute("load_skill", {"name": "missing"}))
        _require(str(missing).startswith("Error:"), missing)
        return {
            7: "allowlist 外的 secret-skill 不进 summary，也不能 load_skill",
            8: "planning-core body 在 system prompt",
            9: "workflow-core 只在 summary，load_skill 后才返回 WORKFLOW_CORE_BODY",
        }

    def check_subagent() -> dict[int, str]:
        shallow = DEFAULT_AGENT_FACTORY.build(context, "main", depth=0)
        still_allowed = DEFAULT_AGENT_FACTORY.build(context, "main", depth=MAX_SUBAGENT_DEPTH - 1)
        limited_depth = DEFAULT_AGENT_FACTORY.build(context, "main", depth=MAX_SUBAGENT_DEPTH)
        _require(shallow.tools.has("subagent"), shallow.tools.tool_names)
        _require(still_allowed.tools.has("subagent"), still_allowed.tools.tool_names)
        _require(not limited_depth.tools.has("subagent"), limited_depth.tools.tool_names)
        blocked = asyncio.run(
            SubagentTool(DEFAULT_AGENT_FACTORY, depth=MAX_SUBAGENT_DEPTH).execute(task="继续下钻")
        )
        _require("depth limit" in str(blocked), blocked)
        return {10: "depth 0 和 2 有 subagent，depth 3 没有，已到最大深度时不再下钻"}

    def check_mcp() -> dict[int, str]:
        normalized = normalize_schema({"type": ["string", "null"]})
        _require(normalized["type"] == "string" and normalized.get("nullable") is True, normalized)
        session = _MockSession(
            [
                {"name": "ping", "description": "ping", "inputSchema": {"type": "object"}},
                {
                    "name": "echo",
                    "description": "echo",
                    "inputSchema": {"oneOf": [{"type": "object"}, {"type": "null"}]},
                },
            ]
        )
        registry = ToolRegistry()
        stack: list[Any] = []
        asyncio.run(
            connect_mcp_servers(
                [{"name": "demo", "session": session, "enabled_tools": ["ping", "echo"]}],
                registry,
                stack,
            )
        )
        _require(registry.has("mcp_demo_ping") and registry.has("mcp_demo_echo"), registry.tool_names)
        echoed = asyncio.run(registry.execute("mcp_demo_echo", {}))
        _require(str(echoed).startswith("echo:"), echoed)
        failing = MCPToolWrapper("demo", {"name": "ping", "description": "ping"}, _MockSession([], fail=True))
        failed = asyncio.run(failing.execute())
        _require(str(failed).startswith("Error executing"), failed)
        slow = MCPToolWrapper(
            "demo",
            {"name": "ping", "description": "ping"},
            _MockSession([], delay=0.2),
            timeout=0.01,
        )
        timed_out = asyncio.run(slow.execute())
        _require("timed out" in str(timed_out), timed_out)
        _require(not any(name.startswith("mcp_") for name in runtime.tools.tool_names), runtime.tools.tool_names)

        class _Empty:
            async def close(self) -> None:
                return None

        loop = AgentLoop(
            session_manager=SimpleNamespace(),
            run_store=SimpleNamespace(),
            llm_client=None,
            agent_factory=DEFAULT_AGENT_FACTORY,
        )
        loop._mcp_stack.append(session)
        asyncio.run(loop._connect_mcp())
        asyncio.run(loop.close_mcp())
        _require(loop._mcp_connected is False, loop._mcp_connected)
        _require(session.closed is True, "MCP stack 没有关闭")
        _require(loop._mcp_stack == [], loop._mcp_stack)
        return {
            11: "mock MCP 工具已包装，主 Profile 没有 mcp_ 工具",
            15: "_connect_mcp 不注册工具，close_mcp 会关闭 stack",
        }

    def check_product_skills() -> dict[int, str]:
        before = _skill_files()
        database = _Database()
        database["user_assets"].docs.append({"user_id": "user-a", "url": "https://assets.test/a-cover.png"})
        app = FastAPI()
        app.add_middleware(AuthenticationMiddleware, backend=_HeaderAuth())
        app.include_router(agent_skills_router, prefix="/api/v3/agent-skills")
        app.state.connections = SimpleNamespace(mongo={"novelcomic": database})
        client = TestClient(app)
        anonymous = client.get("/api/v3/agent-skills/personal")
        _require(anonymous.status_code == 401, anonymous.text)
        try:
            CreateAgentSkillRequest(
                title="",
                description="x",
                original_prompt="hello",
                scenes=["scene"],
                source_type="prompt",
            )
            raise AssertionError("空标题应该被 schema 拒绝")
        except ValidationError:
            pass
        draft = client.post(
            "/api/v3/agent-skills/generate-draft",
            headers={"X-User-Id": "user-a"},
            json={"source_type": "prompt", "original_prompt": "第一幕。第二幕"},
        )
        _require(draft.status_code == 200, draft.text)
        _require(database["agent_skills"].docs == [], "草稿不应该落库")
        bad_file = client.post(
            "/api/v3/agent-skills/generate-draft",
            headers={"X-User-Id": "user-a"},
            json={"source_type": "file", "file_name": "notes.pdf", "file_text": "hi"},
        )
        _require(bad_file.status_code == 400, bad_file.text)
        created = client.post(
            "/api/v3/agent-skills",
            headers={"X-User-Id": "user-a"},
            json={
                "title": "我的技能",
                "description": "说明",
                "cover_url": "https://assets.test/a-cover.png",
                "original_prompt": "保持原文  ",
                "scenes": ["第一幕", "第一幕", "第二幕"],
                "ai_tags": ["tag"],
                "source_type": "prompt",
            },
        )
        _require(created.status_code == 201, created.text)
        skill_id = created.json()["data"]["skill_id"]
        _require(created.json()["data"]["original_prompt"] == "保持原文  ", created.text)
        listed = client.get("/api/v3/agent-skills/personal", headers={"X-User-Id": "user-a"})
        _require(listed.status_code == 200 and listed.json()["data"]["total"] == 1, listed.text)
        updated = client.patch(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"X-User-Id": "user-a"},
            json={"title": "改过的技能"},
        )
        _require(updated.status_code == 200 and updated.json()["data"]["title"] == "改过的技能", updated.text)
        hidden = client.get("/api/v3/agent-skills/personal", headers={"X-User-Id": "user-b"})
        _require(hidden.status_code == 200 and hidden.json()["data"]["skills"] == [], hidden.text)
        foreign_update = client.patch(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"X-User-Id": "user-b"},
            json={"title": "偷改"},
        )
        foreign_delete = client.delete(
            f"/api/v3/agent-skills/personal/{skill_id}",
            headers={"X-User-Id": "user-b"},
        )
        _require(foreign_update.status_code == 404, foreign_update.text)
        _require(foreign_delete.status_code == 404, foreign_delete.text)
        deleted = client.delete(f"/api/v3/agent-skills/personal/{skill_id}", headers={"X-User-Id": "user-a"})
        _require(deleted.status_code == 200, deleted.text)
        after_delete = client.get("/api/v3/agent-skills/personal", headers={"X-User-Id": "user-a"})
        _require(after_delete.json()["data"]["skills"] == [], after_delete.text)
        _require(_skill_files() == before, (_skill_files(), before))
        return {
            12: f"user-a 完成草稿、创建、更新、删除 skill_id={skill_id}",
            13: "user-b 列表为空，更新和删除都是 404",
            14: "产品技能没有写入仓内 SKILL.md",
        }

    _guard(results, (1,), check_definitions)
    _guard(results, (2,), check_undeclared)
    _guard(results, (3,), check_isolated_registries)
    _guard(results, (4, 5), check_cast_and_validate)
    _guard(results, (6,), check_loader)
    _guard(results, (7, 8, 9), check_allowlist_and_prompt)
    _guard(results, (10,), check_subagent)
    _guard(results, (11, 15), check_mcp)
    _guard(results, (12, 13, 14), check_product_skills)
    for item in results:
        if item["ok"] and not item["detail"]:
            item["ok"] = False
            item["detail"] = "这一步没有产生验收结果"
    return results


def main() -> int:
    results = _run()
    passed = sum(1 for item in results if item["ok"])
    for item in results:
        mark = "通过" if item["ok"] else "失败"
        detail = str(item["detail"]).replace("\n", " ")
        print(f"{mark} {item['step']:02d} {item['name']} — {detail}")
    print(f"闭环 {passed}/{len(results)}。工具、仓内 Skills、MCP 适配和产品技能资产需要分层通过。")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
