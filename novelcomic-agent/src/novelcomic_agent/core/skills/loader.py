"""Scan and cache built-in SKILL.md instructions.

Frontmatter is flat ``key: value`` only. Nested YAML and arrays are not supported.
``requires_bins`` and ``requires_env`` are comma-separated. ``name`` must match
the skill directory name.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, replace
from pathlib import Path

BUILTIN_SKILLS_DIR = Path(__file__).resolve().parent


@dataclass(slots=True)
class SkillInfo:
    name: str
    description: str
    trigger: str
    always: bool
    requires_bins: list[str]
    requires_env: list[str]
    content: str
    body: str
    path: Path
    available: bool


@dataclass(slots=True)
class RejectedSkill:
    path: Path
    reason: str


class SkillsLoader:
    """Cache of skills discovered from one directory."""

    def __init__(self, skills_dir: Path | None = None, *, scan: bool = True) -> None:
        self.skills_dir = Path(skills_dir or BUILTIN_SKILLS_DIR)
        self._skills: dict[str, SkillInfo] = {}
        self.rejected: list[RejectedSkill] = []
        if scan:
            self.reload()

    def reload(self) -> None:
        self._skills = {}
        self.rejected = []
        if not self.skills_dir.is_dir():
            return
        for skill_dir in sorted(path for path in self.skills_dir.iterdir() if path.is_dir()):
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.is_file():
                continue
            text = skill_file.read_text(encoding="utf-8")
            fields, body = _parse_frontmatter(text)
            name = fields.get("name", "")
            if not name:
                self.rejected.append(RejectedSkill(skill_file, "missing name"))
                continue
            if name != skill_dir.name:
                reason = f"name {name!r} does not match directory {skill_dir.name!r}"
                self.rejected.append(RejectedSkill(skill_file, reason))
                continue
            requires_bins = _split_csv(fields.get("requires_bins", ""))
            requires_env = _split_csv(fields.get("requires_env", ""))
            available = all(shutil.which(binary) for binary in requires_bins) and all(
                os.environ.get(key) for key in requires_env
            )
            self._skills[name] = SkillInfo(
                name=name,
                description=fields.get("description", ""),
                trigger=fields.get("trigger", ""),
                always=_is_true(fields.get("always", "")),
                requires_bins=requires_bins,
                requires_env=requires_env,
                content=text,
                body=body,
                path=skill_file,
                available=available,
            )

    def filtered(self, allowed_names: list[str] | tuple[str, ...]) -> SkillsLoader:
        allowed = set(allowed_names)
        clone = SkillsLoader(self.skills_dir, scan=False)
        clone._skills = {name: skill for name, skill in self._skills.items() if name in allowed}
        clone.rejected = list(self.rejected)
        return clone

    def list_skills(self, *, available_only: bool = False) -> list[SkillInfo]:
        skills = list(self._skills.values())
        if available_only:
            return [skill for skill in skills if skill.available]
        return skills

    def get_always_skills(self) -> list[str]:
        return [skill.name for skill in self._skills.values() if skill.always and skill.available]

    def load_skill(self, name: str) -> str:
        skill = self._skills.get(name)
        if skill is None or not skill.available:
            known = ", ".join(sorted(self._skills)) or "(none)"
            return f"Error: skill '{name}' is not available. Allowed: {known}"
        return skill.content

    def load_skills_for_context(self, skill_names: list[str]) -> str:
        bodies = [
            self._skills[name].body
            for name in skill_names
            if name in self._skills and self._skills[name].available
        ]
        return "\n\n".join(body for body in bodies if body.strip())

    def build_skills_summary(self) -> str:
        lines: list[str] = []
        for skill in self._skills.values():
            if skill.always or not skill.available:
                continue
            lines.append(f"- {skill.name}: {skill.description} Trigger: {skill.trigger}".rstrip())
        if not lines:
            return ""
        return "Loadable skills:\n" + "\n".join(lines)

    def mark_unavailable(self, name: str) -> None:
        skill = self._skills.get(name)
        if skill is not None:
            self._skills[name] = replace(skill, available=False)


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.startswith("---\n"):
        return {}, text
    close = text.find("\n---", 3)
    if close == -1:
        return {}, text
    fields: dict[str, str] = {}
    for line in text[4:close].split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            continue
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key or key.startswith(("{", "[")):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        fields[key] = value
    body = text[close + 4 :].lstrip("\n")
    return fields, body


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _is_true(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes"}
