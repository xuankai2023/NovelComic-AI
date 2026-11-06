"""Permanent delivery manifest. Object keys and checksums, never signed URLs."""

from typing import Literal

from pydantic import Field

from .base import ContractModel

DeliveryFileCategory = Literal[
    "source",
    "panel",
    "layer",
    "manifest",
    "audio",
    "subtitle",
    "project",
    "preview",
    "final-video",
]


class OutputBatch(ContractModel):
    batch_id: str = Field(min_length=1)
    batch_index: int = Field(ge=0)
    from_frame: int = Field(ge=0)
    end_frame_inclusive: int = Field(ge=0)
    duration_in_frames: int = Field(gt=0)
    shot_ids: list[str]
    reason: str


class DeliveryFileEntry(ContractModel):
    path: str = Field(min_length=1)
    category: DeliveryFileCategory
    order: int = Field(ge=0)
    object_key: str | None = None
    checksum: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    size_bytes: int | None = Field(default=None, ge=0)
    missing_reason: str | None = None


class DeliveryPackageManifest(ContractModel):
    schema_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    generated_at: str = Field(min_length=1)
    project_content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    play_order: list[str]
    batches: list[OutputBatch]
    files: list[DeliveryFileEntry]
