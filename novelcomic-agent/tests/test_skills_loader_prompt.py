from dataclasses import replace
from pathlib import Path

from novelcomic_agent.agents.main.profile import PROFILE, AgentContext, AgentFactory
from novelcomic_agent.agents.main.prompt import assemble_system_prompt
from novelcomic_agent.core.skills.loader import SkillsLoader


def _write_skill(
    root: Path,
    name: str,
    *,
    body: str,
    frontmatter_name: str | None = None,
    description: str | None = None,
    trigger: str | None = None,
    always: bool = False,
    requires_bins: str = "",
    requires_env: str = "",
) -> None:
    skill_dir = root / name
    skill_dir.mkdir()
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        "\n".join(
            [
                "---",
                f"name: {frontmatter_name or name}",
                f"description: {description or f'{name} description'}",
                f"trigger: {trigger or f'use {name}'}",
                f"always: {str(always).lower()}",
                f"requires_bins: {requires_bins}",
                f"requires_env: {requires_env}",
                "---",
                body,
            ]
        ),
        encoding="utf-8",
    )


def test_skills_loader_scans_flat_frontmatter_and_availability(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_bin = bin_dir / "fake-tool"
    fake_bin.write_text("#!/bin/sh\n", encoding="utf-8")
    fake_bin.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))
    monkeypatch.setenv("READY_ENV", "1")

    _write_skill(
        tmp_path,
        "always-skill",
        body="ALWAYS_BODY",
        always=True,
        requires_bins="fake-tool",
        requires_env="READY_ENV",
    )
    _write_skill(tmp_path, "on-demand", body="ON_DEMAND_BODY")
    _write_skill(tmp_path, "needs-env", body="NEEDS_ENV_BODY", requires_env="MISSING_ENV")
    _write_skill(tmp_path, "wrong-name", frontmatter_name="other-name", body="WRONG_BODY")

    loader = SkillsLoader(tmp_path)
    skills = {skill.name: skill for skill in loader.list_skills()}

    assert set(skills) == {"always-skill", "on-demand", "needs-env"}
    assert skills["always-skill"].requires_bins == ["fake-tool"]
    assert skills["always-skill"].requires_env == ["READY_ENV"]
    assert skills["always-skill"].available is True
    assert skills["needs-env"].available is False
    assert [rejected.reason for rejected in loader.rejected] == [
        "name 'other-name' does not match directory 'wrong-name'"
    ]
    assert loader.get_always_skills() == ["always-skill"]
    assert loader.load_skills_for_context(["always-skill"]) == "ALWAYS_BODY"
    assert "ON_DEMAND_BODY" in loader.load_skill("on-demand")
    assert loader.load_skill("needs-env").startswith(
        "Error: skill 'needs-env' is not available."
    )


def test_skills_loader_reload_refreshes_cache(tmp_path: Path) -> None:
    _write_skill(tmp_path, "first", body="FIRST_BODY")
    loader = SkillsLoader(tmp_path)

    assert [skill.name for skill in loader.list_skills()] == ["first"]

    _write_skill(tmp_path, "second", body="SECOND_BODY")
    assert [skill.name for skill in loader.list_skills()] == ["first"]

    loader.reload()
    assert [skill.name for skill in loader.list_skills()] == ["first", "second"]


def test_system_prompt_separates_always_skills_summary_and_tools(tmp_path: Path) -> None:
    _write_skill(tmp_path, "always-skill", body="ALWAYS_BODY", always=True)
    _write_skill(
        tmp_path,
        "on-demand",
        body="ON_DEMAND_BODY",
        description="Load only when asked",
        trigger="when detailed instructions are needed",
    )
    loader = SkillsLoader(tmp_path)

    prompt = assemble_system_prompt(
        "BASE_PROMPT",
        skills_loader=loader.filtered(["always-skill", "on-demand"]),
        tool_names=["read_file", "load_skill"],
    )

    assert "BASE_PROMPT" in prompt
    assert "ALWAYS_BODY" in prompt
    assert "ON_DEMAND_BODY" not in prompt
    assert (
        "- on-demand: Load only when asked Trigger: when detailed instructions are needed"
        in prompt
    )
    assert "Available tools: read_file, load_skill" in prompt


def test_profile_skill_allowlist_filters_prompt(tmp_path: Path) -> None:
    _write_skill(tmp_path, "workflow-core", body="WORKFLOW_BODY")
    _write_skill(tmp_path, "planning-core", body="PLANNING_BODY", always=True)
    profile_without_planning = replace(
        PROFILE,
        name="without-planning",
        loadable_skills=("workflow-core",),
    )
    factory = AgentFactory(
        profiles={profile_without_planning.name: profile_without_planning},
        skills_loader=SkillsLoader(tmp_path),
    )

    runtime = factory.build(AgentContext(workspace=str(tmp_path)), name="without-planning")

    assert "workflow-core" in runtime.system_prompt
    assert "PLANNING_BODY" not in runtime.system_prompt
    assert "planning-core" not in runtime.system_prompt
