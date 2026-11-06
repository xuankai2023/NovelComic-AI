from dataclasses import replace
from pathlib import Path

from novelcomic_agent.agents.main.profile import (
    PROFILE,
    AgentContext,
    AgentFactory,
    _web_fetch_tool,
)
from novelcomic_agent.core.skills.loader import SkillsLoader
from novelcomic_agent.core.tools.filesystem import LoadSkillTool, ReadFileTool


def _write_skill(root: Path, name: str, *, body: str, always: bool = False) -> None:
    skill_dir = root / name
    skill_dir.mkdir()
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                f"description: {name} description",
                f"trigger: use {name}",
                f"always: {str(always).lower()}",
                "---",
                body,
            ]
        ),
        encoding="utf-8",
    )


def test_main_profile_exposes_only_first_round_factories(tmp_path: Path) -> None:
    _write_skill(tmp_path, "workflow-core", body="WORKFLOW_BODY")
    _write_skill(tmp_path, "planning-core", body="PLANNING_BODY", always=True)

    factory = AgentFactory(skills_loader=SkillsLoader(tmp_path))
    runtime = factory.build(AgentContext(workspace=str(tmp_path)))
    definition_names = {
        definition["function"]["name"] for definition in runtime.tools.get_definitions()
    }

    assert {
        "read_file",
        "web_search",
        "web_fetch",
        "load_skill",
        "run_workflow",
        "get_workflow",
        "get_workflow_results",
        "get_node_spec",
        "edit_workflow",
        "update_canvas_node",
        "search_templates",
        "use_template",
        "hitl",
    }.issubset(definition_names)
    assert "media_understanding" not in definition_names
    assert "WORKFLOW_BODY" not in runtime.system_prompt
    assert "PLANNING_BODY" in runtime.system_prompt


def test_removed_profile_factory_disappears_from_tool_definitions(tmp_path: Path) -> None:
    profile_without_fetch = replace(
        PROFILE,
        name="without-fetch",
        tool_factories=tuple(
            factory for factory in PROFILE.tool_factories if factory is not _web_fetch_tool
        ),
    )
    agent_factory = AgentFactory(
        profiles={profile_without_fetch.name: profile_without_fetch},
        skills_loader=SkillsLoader(tmp_path),
    )

    runtime = agent_factory.build(AgentContext(workspace=str(tmp_path)), name="without-fetch")
    definition_names = {
        definition["function"]["name"] for definition in runtime.tools.get_definitions()
    }

    assert "read_file" in definition_names
    assert "web_search" in definition_names
    assert "web_fetch" not in definition_names


async def test_read_file_respects_workspace_and_slice(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "story.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("secret\n", encoding="utf-8")

    tool = ReadFileTool(str(workspace))

    assert await tool.execute(path="story.txt", offset=2, limit=2) == "2|beta\n3|gamma"
    assert (await tool.execute(path="../secret.txt")).startswith(
        "Error: read_file cannot read files outside the workspace."
    )


async def test_load_skill_uses_allowlisted_loader(tmp_path: Path) -> None:
    _write_skill(tmp_path, "workflow-core", body="WORKFLOW_BODY")
    _write_skill(tmp_path, "planning-core", body="PLANNING_BODY")
    loader = SkillsLoader(tmp_path).filtered(["workflow-core"])
    tool = LoadSkillTool(loader)

    assert "WORKFLOW_BODY" in await tool.execute(name="workflow-core")
    assert (await tool.execute(name="planning-core")).startswith(
        "Error: skill 'planning-core' is not available."
    )
    assert (await tool.execute(name="missing")).startswith(
        "Error: skill 'missing' is not available."
    )
