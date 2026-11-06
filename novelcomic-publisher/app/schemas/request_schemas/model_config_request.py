"""Internal model configuration request schemas."""

from typing import Any

from pydantic import BaseModel, Field


class UpsertModelConfigRequest(BaseModel):
    config_name: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    pricing: Any = None
    params: dict[str, Any] = Field(default_factory=dict)
    input_mapping: dict[str, str] | None = None


class DeleteModelConfigRequest(BaseModel):
    config_name: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
