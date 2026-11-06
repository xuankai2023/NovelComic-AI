"""Flow project response shapes."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class SaveWorkflowProjectRequest(BaseModel):
    project_name: str = Field(default="Untitled", min_length=1, max_length=255)
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    parent_flow_id: str | None = None
    allow_reshare: bool = True


class UpdateWorkflowProjectRequest(BaseModel):
    flow_id: str = Field(min_length=1)
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class UpdateWorkflowProjectDetailsRequest(BaseModel):
    flow_id: str = Field(min_length=1)
    project_name: str | None = None
    snapshot_url: str | None = None
    snapshot_thumbnail_url: str | None = None


class WorkflowProjectSnapshot(BaseModel):
    snapshot_url: str = ""
    snapshot_thumbnail_url: str = ""


class WorkflowProjectDetails(BaseModel):
    flow_id: str | None = None
    project_name: str = "Untitled"
    created_at: datetime | None = None
    updated_at: datetime | None = None
    time_zone: str | None = None
    snapshot: WorkflowProjectSnapshot | None = None
    app_mode_config: dict[str, Any] | None = None


class WorkflowProjectResponse(BaseModel):
    flow_id: str
    user_id: str | None = None
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    details: WorkflowProjectDetails = Field(default_factory=WorkflowProjectDetails)
    allow_reshare: bool = True
    parent_flow_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    time_zone: str | None = None
    last_view_time: datetime | None = None
