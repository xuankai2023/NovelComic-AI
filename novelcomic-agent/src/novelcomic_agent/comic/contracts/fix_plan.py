"""One automatic correction round. The plan is not a JSON patch."""

from typing import Literal

from pydantic import Field

from .base import ContractModel
from .compose_command import ComposeCommandInput

FixDecision = Literal["approved", "rejected"]


class FixPlan(ContractModel):
    decision: FixDecision
    reason: str = Field(min_length=1)
    commands: list[ComposeCommandInput] = Field(default_factory=list)
    expected_revision: int = Field(ge=0)
    estimated_cost_fen: int = Field(ge=0)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
