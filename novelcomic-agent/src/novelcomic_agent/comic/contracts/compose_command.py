"""Durable Compose command ledger contracts."""

from typing import Any, Literal

from pydantic import Field

from .base import ContractModel
from .ids import CommandId, ProjectId

ComposeCommandStatus = Literal["pending", "running", "committed", "failed"]


class ComposeCommandRecord(ContractModel):
    command_id: CommandId
    project_id: ProjectId
    ordinal: int = Field(ge=0)
    name: str = Field(min_length=1)
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_revision: int = Field(ge=0)
    resulting_revision: int | None = Field(default=None, gt=0)
    status: ComposeCommandStatus
    attempt: int = Field(ge=0)
    last_error_code: str | None = Field(default=None, min_length=1)


class ComposeCommandInput(ContractModel):
    command_id: CommandId
    project_id: ProjectId
    ordinal: int = Field(ge=0)
    name: str = Field(min_length=1)
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    payload: dict[str, Any]
