"""Developer API client (sk_ key) schemas."""

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class CreateDeveloperApiClientRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    rate_limit_per_minute: int | None = Field(default=None, ge=1)


class DeveloperApiClient(BaseModel):
    client_id: str = Field(default_factory=lambda: f"cli_{uuid4().hex[:16]}")
    name: str
    owner_user_id: str
    api_key: str
    api_key_hash: str
    key_suffix: str
    allowed_flow_ids: list[str] = Field(default_factory=list)
    status: Literal["active", "revoked"] = "active"
    rate_limit_per_minute: int | None = None
    time_zone: str = "UTC"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
