"""Share persistence and response shapes."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.request_schemas.share.create_share_request import ShareType


class DataBaseCreateFlowTask(BaseModel):
    flow_id: str
    project_name: str = "Untitled"
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)
    allow_reshare: bool = True
    parent_flow_id: str | None = None


class ShareDocument(BaseModel):
    share_id: str
    flow_id: str
    owner_user_id: str
    owner_email: str | None = None
    email_whitelist: list[str] = Field(default_factory=list)
    allow_reshare: bool = True
    share_type: ShareType = "workflow"
    snapshot: DataBaseCreateFlowTask
    created_at: datetime
    updated_at: datetime


class ShareInfoResponse(BaseModel):
    share_id: str
    flow_id: str
    owner_user_id: str
    share_type: ShareType
    allow_reshare: bool
    need_auth: bool
    snapshot: DataBaseCreateFlowTask | None = None


class ShareVisitResponse(BaseModel):
    share_id: str
    flow_id: str
    owner_user_id: str
    share_type: ShareType
    allow_reshare: bool
    snapshot: DataBaseCreateFlowTask
