"""Public Agent catalog entity shapes."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer

CatalogStatus = Literal["draft", "published", "archived"]


class AgentCatalogBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: dict[str, str] = Field(default_factory=dict)
    description: dict[str, str] = Field(default_factory=dict)
    tags: list[dict[str, str]] = Field(default_factory=list)
    cover_url: str | None = None
    icon_url: str | None = None
    sort_order: int = 0
    status: CatalogStatus = "draft"
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    published_at: datetime | None = None

    @field_serializer("created_at", "updated_at", "published_at", when_used="json")
    def serialize_datetime(self, value: datetime | None) -> str | None:
        if value is None:
            return None
        return value.strftime("%Y-%m-%d %H:%M:%S")


class AgentCatalogHook(AgentCatalogBase):
    kind: Literal["hook"] = "hook"
    hook_id: str = Field(min_length=1)
    hook_type: str = Field(min_length=1)
    prompt: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class AgentCatalogRole(AgentCatalogBase):
    kind: Literal["role"] = "role"
    role_id: str = Field(min_length=1)
    role_type: str = "avatar"
    prompt: str = ""
    avatar_url: str | None = None


class AgentCatalogPage(BaseModel):
    items: list[dict[str, Any]]
    total: int
    page: int
    pageSize: int
