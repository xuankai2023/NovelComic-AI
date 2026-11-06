"""Media face verification request and response shapes."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

MediaVerificationStatus = Literal[
    "pending",
    "processing",
    "active",
    "rejected",
    "failed",
    "unknown",
]
MediaVerificationApiStatus = Literal[
    "pending",
    "processing",
    "active",
    "rejected",
    "failed",
    "unknown",
    "not_found",
]
MediaFaceProvider = Literal["byteplus"]
MediaFaceType = Literal["image", "video"]


class IngestMediaFaceVerificationRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    type: MediaFaceType = "image"
    content_hash: str | None = Field(default=None, max_length=128)


class FetchMediaFaceVerificationsRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=100)


class IngestMediaFaceVerificationResponse(BaseModel):
    status: MediaVerificationStatus
    is_new: bool
    reused_from_content_hash: bool


class MediaFaceVerificationItem(BaseModel):
    url: str
    status: MediaVerificationApiStatus
    provider: MediaFaceProvider | None = None
    content_hash: str | None = None
    last_error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class FetchMediaFaceVerificationsResponse(BaseModel):
    items: list[MediaFaceVerificationItem]


class FaceProviderState(BaseModel):
    project_name: str | None = None
    asset_id: str | None = None
    group_id: str | None = None
    asset_name: str | None = None
    asset_url: str | None = None
    verification_status: MediaVerificationStatus = "pending"
    sync_status: Literal["pending", "syncing", "synced", "sync_failed", "failed"] = "pending"
    last_sync_error: Any | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
