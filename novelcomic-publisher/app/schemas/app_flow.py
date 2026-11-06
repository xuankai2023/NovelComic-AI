"""App flow persistence and response shapes."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AppFlow(BaseModel):
    flow_id: str
    user_id: str
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    title: str | None = None
    description: str | None = None
    demo_image_urls: list[str] | None = None
    visible_nodes: list[str] | None = None
    app_mode_config: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
