from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_id: str = Field(min_length=1)
    options: dict[str, Any] = Field(default_factory=dict)
    webhook_url: str = Field(min_length=1)
    trace_id: str | None = Field(default=None, min_length=1)
    idempotency_key: str | None = Field(default=None, min_length=1)
    locale: Literal["zh", "en"] | None = None
    client_context: dict[str, Any] | None = None


class CreateTaskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ai_task_id: str = Field(min_length=1)
    status: Literal["queued", "existing"] = "queued"
    existing: bool = False


OpenCreatorAITaskRequest = CreateTaskRequest
OpenCreatorAITaskResponse = CreateTaskResponse
