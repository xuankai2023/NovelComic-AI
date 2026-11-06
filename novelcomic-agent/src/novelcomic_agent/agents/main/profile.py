"""Main agent profile declaration.

The profile decides which tools the main NovelComic agent may see and which
runtime defaults override the base AgentLoop defaults.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from novelcomic_agent.agents.main.prompt import assemble_system_prompt
from novelcomic_agent.core.skills.loader import SkillsLoader
from novelcomic_agent.core.tools.canvas_tools import (
    EditWorkflowTool,
    GetNodeSpecTool,
    GetWorkflowResultsTool,
    GetWorkflowTool,
    HitlTool,
    SearchTemplatesTool,
    UpdateCanvasNodeTool,
    UseTemplateTool,
)
from novelcomic_agent.core.tools.filesystem import LoadSkillTool, ReadFileTool
from novelcomic_agent.core.tools.registry import ToolRegistry
from novelcomic_agent.core.tools.run_workflow import RunWorkflowTool
from novelcomic_agent.core.tools.subagent import MAX_SUBAGENT_DEPTH, SubagentTool
from novelcomic_agent.core.tools.web import WebFetchTool, WebSearchTool


@runtime_checkable
class AgentTool(Protocol):
    """Minimal tool contract consumed by ``novelcomic_agent.core.loop``."""

    name: str
    description: str

    async def execute(self, arguments: Mapping[str, Any], context: AgentContext) -> Any:
        """Execute the tool with provider-supplied arguments."""


@dataclass(slots=True)
class AgentContext:
    """Dependency bag used by profile tool factories.

    Most fields are intentionally optional because tools arrive incrementally.
    A concrete tool should validate the dependency it needs when it is built or
    executed instead of making the main profile unusable.
    """

    user_id: str = ""
    session_id: str = ""
    run_id: str = ""
    flow_id: str | None = None
    workspace: str | None = None
    workflow_snapshot: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    settings: Any | None = None
    workflow_engine: Any | None = None
    workflow_dao: Any | None = None
    redis_client: Any | None = None
    templates_col: Any | None = None
    share_flow_col: Any | None = None
    openai_client: Any | None = None
    llm_client: Any | None = None
    http_client: Any | None = None
    extra: dict[str, Any] = field(default_factory=dict)


ToolFactory = Callable[[AgentContext], AgentTool]
SystemPromptBuilder = str | Callable[[AgentContext], str]


@dataclass(frozen=True, slots=True)
class AgentProfile:
    """Declarative runtime configuration for one agent profile."""

    name: str
    description: str
    system_prompt: SystemPromptBuilder
    tool_factories: tuple[ToolFactory, ...] = ()
    model: str | None = None
    max_iterations: int | None = None
    inline_skills: tuple[str, ...] = ()
    loadable_skills: tuple[str, ...] = ()

    def build_system_prompt(self, ctx: AgentContext) -> str:
        if callable(self.system_prompt):
            return self.system_prompt(ctx)
        return self.system_prompt

    def build_tools(self, ctx: AgentContext) -> dict[str, AgentTool]:
        tools: dict[str, AgentTool] = {}
        for factory in self.tool_factories:
            tool = factory(ctx)
            if not tool.name:
                raise ValueError(f"tool factory {factory!r} returned a tool without a name")
            tools[tool.name] = tool
        return tools


@dataclass(slots=True)
class RuntimeAgentProfile:
    """Materialized profile with its prompt and tool registry."""

    profile: AgentProfile
    context: AgentContext
    system_prompt: str
    tools: ToolRegistry

    @property
    def model(self) -> str | None:
        return self.profile.model

    @property
    def max_iterations(self) -> int | None:
        return self.profile.max_iterations


class AgentFactory:
    """Build registered profiles for callers such as API background tasks."""

    def __init__(
        self,
        profiles: Mapping[str, AgentProfile] | None = None,
        skills_loader: SkillsLoader | None = None,
    ) -> None:
        default_profiles = {PROFILE.name: PROFILE, RESEARCH_PROFILE.name: RESEARCH_PROFILE}
        self._profiles = dict(profiles or default_profiles)
        self._skills = skills_loader or SkillsLoader()

    def get_profile(self, name: str = "main") -> AgentProfile:
        try:
            return self._profiles[name]
        except KeyError as exc:
            raise KeyError(f"unknown agent profile: {name}") from exc

    def build(self, ctx: AgentContext, name: str = "main", depth: int = 0) -> RuntimeAgentProfile:
        profile = self.get_profile(name)
        tools = ToolRegistry()
        for factory in profile.tool_factories:
            tools.register(factory(ctx))
        allowed = list(profile.inline_skills) + list(profile.loadable_skills)
        filtered_skills = self._skills.filtered(allowed)
        if profile.loadable_skills:
            tools.register(LoadSkillTool(filtered_skills))
        has_subagent = any(profile_name != "main" for profile_name in self._profiles)
        if has_subagent and depth < MAX_SUBAGENT_DEPTH:
            subagent = SubagentTool(self, depth=depth)
            subagent.bind_context(ctx)
            tools.register(subagent)
        return RuntimeAgentProfile(
            profile=profile,
            context=ctx,
            system_prompt=assemble_system_prompt(
                profile.build_system_prompt(ctx),
                skills_loader=filtered_skills,
                tool_names=tools.tool_names,
            ),
            tools=tools,
        )


class DeferredTool:
    """Tool placeholder that keeps the profile buildable before tool code lands."""

    def __init__(
        self,
        *,
        name: str,
        description: str,
        dependency_key: str | None = None,
        callable_name: str | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = {"type": "object", "properties": {}}
        self.dependency_key = dependency_key
        self.callable_name = callable_name or name

    async def execute(self, arguments: Mapping[str, Any], context: AgentContext) -> Any:
        target = _resolve_dependency(context, self.dependency_key or self.name)
        if target is None:
            raise ToolUnavailableError(
                f"tool '{self.name}' is not configured; missing dependency "
                f"'{self.dependency_key or self.name}'"
            )
        method = getattr(target, self.callable_name, None)
        if method is None:
            method = target if callable(target) else None
        if method is None:
            raise ToolUnavailableError(
                f"tool '{self.name}' dependency does not expose '{self.callable_name}'"
            )
        result = method(dict(arguments), context)
        if hasattr(result, "__await__"):
            result = await result
        return result


class ToolUnavailableError(RuntimeError):
    """Raised when a profile-visible tool has not been wired yet."""


def build_main_system_prompt(ctx: AgentContext) -> str:
    flow_hint = f"\nCurrent workflow id: {ctx.flow_id}" if ctx.flow_id else ""
    return (
        "You are NovelComic's main production agent. Help the user operate the "
        "current comic/video workflow, explain actions before destructive edits, "
        "prefer existing canvas context, and use tools for workflow, template, "
        "file, web, and media operations when needed."
        f"{flow_hint}"
    )


def _resolve_dependency(ctx: AgentContext, key: str) -> Any:
    if hasattr(ctx, key):
        value = getattr(ctx, key)
        if value is not None:
            return value
    return ctx.extra.get(key)


def _read_file_tool(ctx: AgentContext) -> ReadFileTool:
    return ReadFileTool(ctx.workspace)


def _web_search_tool(ctx: AgentContext) -> WebSearchTool:
    return WebSearchTool(ctx.extra.get("web_search"))


def _web_fetch_tool(ctx: AgentContext) -> WebFetchTool:
    return WebFetchTool(ctx.extra.get("web_fetch"))


def _run_workflow_tool(ctx: AgentContext) -> RunWorkflowTool:
    return RunWorkflowTool(ctx.workflow_dao, context=ctx)


def _get_workflow_tool(ctx: AgentContext) -> GetWorkflowTool:
    return GetWorkflowTool(context=ctx)


def _get_workflow_results_tool(ctx: AgentContext) -> GetWorkflowResultsTool:
    return GetWorkflowResultsTool(context=ctx)


def _get_node_spec_tool(_ctx: AgentContext) -> GetNodeSpecTool:
    return GetNodeSpecTool()


def _edit_workflow_tool(ctx: AgentContext) -> EditWorkflowTool:
    return EditWorkflowTool(context=ctx)


def _update_canvas_node_tool(ctx: AgentContext) -> UpdateCanvasNodeTool:
    return UpdateCanvasNodeTool(context=ctx)


def _search_templates_tool(ctx: AgentContext) -> SearchTemplatesTool:
    return SearchTemplatesTool(context=ctx)


def _use_template_tool(ctx: AgentContext) -> UseTemplateTool:
    return UseTemplateTool(context=ctx)


def _hitl_tool(_ctx: AgentContext) -> HitlTool:
    return HitlTool()


# def _continue_workflow(ctx: AgentContext) -> AgentTool:
#     from novelcomic_agent.core.tools.continue_workflow import ContinueWorkflowTool
#
#     return ContinueWorkflowTool(
#         workflow_engine=ctx.workflow_engine,
#         workflow_dao=ctx.workflow_dao,
#     )


def _deferred_tool(
    name: str,
    description: str,
    *,
    dependency_key: str | None = None,
    callable_name: str | None = None,
) -> ToolFactory:
    return lambda _ctx: DeferredTool(
        name=name,
        description=description,
        dependency_key=dependency_key,
        callable_name=callable_name,
    )


PROFILE = AgentProfile(
    name="main",
    description="Primary NovelComic conversational agent with workspace, web, and skill tools.",
    system_prompt=build_main_system_prompt,
    tool_factories=(
        _read_file_tool,
        _web_search_tool,
        _web_fetch_tool,
        _run_workflow_tool,
        _get_workflow_tool,
        _get_workflow_results_tool,
        _get_node_spec_tool,
        _edit_workflow_tool,
        _update_canvas_node_tool,
        _search_templates_tool,
        _use_template_tool,
        _hitl_tool,
    ),
    inline_skills=(),
    loadable_skills=("workflow-core", "planning-core"),
    max_iterations=60,
)


RESEARCH_PROFILE = AgentProfile(
    name="research",
    description="Read-only child agent for bounded lookup tasks.",
    system_prompt="You research the current workspace and the web, then report a short answer.",
    tool_factories=(_read_file_tool, _web_search_tool, _web_fetch_tool),
    inline_skills=(),
    loadable_skills=(),
)


MAIN_PROFILE = PROFILE
DEFAULT_AGENT_FACTORY = AgentFactory()
