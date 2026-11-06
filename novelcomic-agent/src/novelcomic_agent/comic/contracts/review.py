"""Structured review issues. A missing evidence record cannot approve a fix."""

from typing import Any, Literal

from pydantic import Field

from .base import ContractModel

ReviewSeverity = Literal["info", "warning", "error"]
EvidenceKind = Literal["frame", "still", "preview", "summary"]


class ReviewEvidence(ContractModel):
    kind: EvidenceKind
    shot_id: str | None = None
    frame: int | None = Field(default=None, ge=0)
    artifact_id: str | None = None
    object_key: str | None = None
    detail: str = ""


class ReviewIssue(ContractModel):
    code: str = Field(min_length=1)
    severity: ReviewSeverity
    shot_id: str | None = None
    evidence: list[ReviewEvidence] = Field(default_factory=list)
    suggested_action: str | None = None
    confidence: float = Field(ge=0, le=1)
    message: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)
    actionable: bool = False


class ReviewReport(ContractModel):
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewer_version: str = Field(min_length=1)
    rule_version: str = Field(min_length=1)
    issues: list[ReviewIssue]
    stale: bool = False
    raw_artifact_key: str | None = None
