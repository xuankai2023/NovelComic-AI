"""Assemble the main agent system prompt from base text, skills, and tools."""

from __future__ import annotations

from novelcomic_agent.core.skills.loader import SkillsLoader


def assemble_system_prompt(
    base_prompt: str,
    *,
    skills_loader: SkillsLoader,
    tool_names: list[str],
) -> str:
    parts = [base_prompt.strip()]
    always_body = skills_loader.load_skills_for_context(skills_loader.get_always_skills())
    if always_body:
        parts.append(always_body)
    summary = skills_loader.build_skills_summary()
    if summary:
        parts.append(summary)
    if tool_names:
        parts.append("Available tools: " + ", ".join(tool_names))
    return "\n\n".join(part for part in parts if part)
