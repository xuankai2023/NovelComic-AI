"""Reusable result of a paid or time-consuming production stage."""

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import AnyUrl, Field

from .base import ContractModel
from .ids import ArtifactId, ProjectId, ShotId

ArtifactStage = Literal[
    "ingest",
    "analyze",
    "tts",
    "clean-panel",
    "l0-panel",
    "layer-l1",
    "layer-l2",
    "inpaint",
    "preview",
    "render-batch",
    "package",
]
ArtifactStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


class AssetArtifact(ContractModel):
    artifact_id: ArtifactId
    project_id: ProjectId
    shot_id: ShotId | None = None
    stage: ArtifactStage
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider: str = Field(min_length=1)
    provider_request_id: str | None = Field(default=None, min_length=1)
    status: ArtifactStatus
    urls: list[AnyUrl]
    checksums: list[str]
    diagnostics: dict[str, Any]
    cost_rmb: Decimal = Field(ge=0, allow_inf_nan=False)
    created_at: datetime
