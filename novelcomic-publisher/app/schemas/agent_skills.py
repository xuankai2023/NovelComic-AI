"""User-owned Agent Skill assets. These are not runtime SKILL.md files."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

SourceType = Literal["video", "prompt", "file"]
MAX_FILE_BYTES = 1_000_000
MAX_TITLE_LENGTH = 80
MAX_DESCRIPTION_LENGTH = 500
MAX_ORIGINAL_PROMPT_LENGTH = 8_000
MAX_SCENE_COUNT = 8
MAX_LABEL_LENGTH = 32
MAX_AI_TAG_COUNT = 12
MAX_MEDIA_URL_LENGTH = 4096


def _normalize_title(value: str) -> str:
    title = value.strip()
    if not title:
        raise ValueError("title must not be blank")
    if len(title) > MAX_TITLE_LENGTH:
        raise ValueError(f"title must be at most {MAX_TITLE_LENGTH} characters")
    return title


def _normalize_description(value: str | None) -> str:
    description = (value or "").strip()
    if len(description) > MAX_DESCRIPTION_LENGTH:
        raise ValueError(f"description must be at most {MAX_DESCRIPTION_LENGTH} characters")
    return description


def _normalize_labels(
    values: list[str],
    *,
    field_name: str,
    min_count: int = 0,
    max_count: int,
) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        label = value.strip()
        if not label:
            continue
        if len(label) > MAX_LABEL_LENGTH:
            raise ValueError(f"{field_name} items must be at most {MAX_LABEL_LENGTH} characters")
        key = label.casefold()
        if key not in seen:
            seen.add(key)
            cleaned.append(label)
    if len(cleaned) < min_count or len(cleaned) > max_count:
        raise ValueError(f"{field_name} must contain {min_count} to {max_count} unique values")
    return cleaned


def _validate_original_prompt(value: str) -> str:
    if not value.strip():
        raise ValueError("original_prompt must not be blank")
    if len(value) > MAX_ORIGINAL_PROMPT_LENGTH:
        raise ValueError(
            f"original_prompt must be at most {MAX_ORIGINAL_PROMPT_LENGTH} characters"
        )
    return value


class GenerateAgentSkillDraftRequest(BaseModel):
    source_type: SourceType
    original_prompt: str = Field(default="", max_length=MAX_ORIGINAL_PROMPT_LENGTH)
    file_name: str | None = Field(default=None, max_length=255)
    file_text: str | None = None
    video_url: str | None = Field(default=None, max_length=MAX_MEDIA_URL_LENGTH)
    supplemental_text: str | None = Field(default=None, max_length=MAX_ORIGINAL_PROMPT_LENGTH)

    @model_validator(mode="after")
    def require_source_fields(self) -> GenerateAgentSkillDraftRequest:
        if self.source_type == "prompt" and not self.original_prompt.strip():
            raise ValueError("original_prompt is required")
        if self.source_type == "file":
            if not self.file_name:
                raise ValueError("file_name is required")
            if self.file_text is None or not self.file_text.strip():
                raise ValueError("file_text is required")
        if self.source_type == "video" and not (self.video_url and self.video_url.strip()):
            raise ValueError("video_url is required")
        return self


class CreateAgentSkillRequest(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    description: str = Field(default="", max_length=MAX_DESCRIPTION_LENGTH)
    cover_url: str | None = Field(default=None, max_length=MAX_MEDIA_URL_LENGTH)
    video_url: str | None = Field(default=None, max_length=MAX_MEDIA_URL_LENGTH)
    original_prompt: str = Field(min_length=1, max_length=MAX_ORIGINAL_PROMPT_LENGTH)
    scenes: list[str] = Field(min_length=1)
    ai_tags: list[str] = Field(default_factory=list)
    source_type: SourceType
    generation_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        return _normalize_title(value)

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str:
        return _normalize_description(value)

    @field_validator("original_prompt")
    @classmethod
    def validate_original_prompt(cls, value: str) -> str:
        return _validate_original_prompt(value)

    @field_validator("scenes")
    @classmethod
    def normalize_scenes(cls, value: list[str]) -> list[str]:
        return _normalize_labels(
            value,
            field_name="scenes",
            min_count=1,
            max_count=MAX_SCENE_COUNT,
        )

    @field_validator("ai_tags")
    @classmethod
    def normalize_tags(cls, value: list[str]) -> list[str]:
        return _normalize_labels(
            value,
            field_name="ai_tags",
            max_count=MAX_AI_TAG_COUNT,
        )

    @model_validator(mode="after")
    def require_source_fields(self) -> CreateAgentSkillRequest:
        if self.source_type == "video" and not (self.video_url and self.video_url.strip()):
            raise ValueError("video_url is required")
        return self


class UpdateAgentSkillRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE_LENGTH)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH)
    cover_url: str | None = Field(default=None, max_length=MAX_MEDIA_URL_LENGTH)
    video_url: str | None = Field(default=None, max_length=MAX_MEDIA_URL_LENGTH)
    scenes: list[str] | None = None
    ai_tags: list[str] | None = None

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _normalize_title(value)

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str:
        return _normalize_description(value)

    @field_validator("scenes")
    @classmethod
    def normalize_scenes(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_labels(
            value,
            field_name="scenes",
            min_count=1,
            max_count=MAX_SCENE_COUNT,
        )

    @field_validator("ai_tags")
    @classmethod
    def normalize_tags(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_labels(
            value,
            field_name="ai_tags",
            max_count=MAX_AI_TAG_COUNT,
        )


class AgentSkillDraft(BaseModel):
    title: str
    description: str
    scenes: list[str]
    ai_tags: list[str]
    original_prompt: str
    source_type: SourceType
    generation_metadata: dict[str, Any] = Field(default_factory=dict)


class AgentSkillItem(CreateAgentSkillRequest):
    skill_id: str
    user_id: str
    status: Literal["active", "deleted"] = "active"


class AgentSkillListResponse(BaseModel):
    skills: list[AgentSkillItem]
    total: int
