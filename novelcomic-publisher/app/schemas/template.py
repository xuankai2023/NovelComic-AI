"""Template marketplace entity shapes."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


class WorkflowStage(BaseModel):
    name: str = ""
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)


class WorkflowIOItem(BaseModel):
    type: str = ""
    label: str = ""


class WorkflowIO(BaseModel):
    inputs: list[WorkflowIOItem] = Field(default_factory=list)
    outputs: list[WorkflowIOItem] = Field(default_factory=list)

    @field_validator("inputs", "outputs", mode="before")
    @classmethod
    def normalize_items(cls, value: Any) -> Any:
        if value is None:
            return []
        if not isinstance(value, list):
            return value
        return [{"type": item, "label": item} if isinstance(item, str) else item for item in value]


class StatsBoost(BaseModel):
    created_count: int = Field(default=0, ge=0)
    user_count: int = Field(default=0, ge=0)
    acquired_user_count: int = Field(default=0, ge=0)
    run_count: int = Field(default=0, ge=0)
    total_credits: int = Field(default=0, ge=0)


class Template(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    template_id: str = Field(min_length=1)
    name: dict[str, str] = Field(default_factory=dict)
    desc: dict[str, str] = Field(default_factory=dict)
    tags: list[dict[str, str]] = Field(default_factory=list)
    models: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    covers: list[str] = Field(default_factory=list)
    videos: list[str] = Field(default_factory=list)
    snapshot: str | None = None
    share_url: str | None = None
    share_id: str | None = None
    origin_flow_id: str | None = None
    link_type: str | None = None
    workflow_stages: list[WorkflowStage] = Field(default_factory=list)
    workflow_io: WorkflowIO | None = None
    estimated_credits: int = Field(default=0, ge=0)
    is_hot: bool = False
    is_recommend: bool = False
    run_count: int = Field(default=0, ge=0)
    stats_boost: StatsBoost = Field(default_factory=StatsBoost)
    status: str = "draft"
    created_at: datetime | None = None
    updated_at: datetime | None = None
    published_at: datetime | None = None

    @field_serializer("created_at", "updated_at", "published_at", when_used="json")
    def serialize_datetime(self, value: datetime | None) -> str | None:
        if value is None:
            return None
        return value.strftime("%Y-%m-%d %H:%M:%S")
