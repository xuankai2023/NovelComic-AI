"""Workflow run REST 接口形状。"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateWorkflowRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_request_id: str = Field(min_length=1, max_length=128)
    command_id: str | None = Field(default=None, min_length=1, max_length=128)
    flow_id: str = Field(min_length=1)
    flow_task: dict[str, Any]
    start_ids: list[str] = Field(default_factory=list)
    end_ids: list[str] = Field(default_factory=list)
    run_mode: Literal["global", "selected_nodes", "single_node"] = "global"
    user_selection: dict[str, Any] = Field(default_factory=dict)
    locale: str | None = None
    intent_node_ids: list[str] = Field(default_factory=list)


class ContinueWorkflowRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=128)
    flow_run_id: str = Field(min_length=1, max_length=128)
    flow_task: dict[str, Any]
    start_ids: list[str] = Field(default_factory=list)
    user_selection: dict[str, Any] = Field(default_factory=dict)
    locale: str | None = None


class CancelWorkflowRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=128)


class WorkflowRunResponse(BaseModel):
    flow_task_id: str
    flow_run_id: str
    trace_id: str
    status: str
    idempotent_replay: bool = False
    flow_id: str | None = None
    flow_task: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
