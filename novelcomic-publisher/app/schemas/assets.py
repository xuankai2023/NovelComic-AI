"""Personal asset library request and response shapes."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

AssetLibraryKind = Literal["character", "product", "brand_visual"]
AssetSourceKind = Literal["uploaded", "generated"]
AssetMediaType = Literal["image", "video"]
AssetMediaFilter = Literal["all", "image", "video"]


class AssetResourceInfo(BaseModel):
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    format: str | None = Field(default=None, max_length=64)
    file_size: int | None = Field(default=None, ge=0)
    codec: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def validate_dimensions_together(self) -> "AssetResourceInfo":
        has_width = self.width is not None
        has_height = self.height is not None
        if has_width != has_height:
            raise ValueError(
                "resource_info.width and resource_info.height must be provided together"
            )
        return self


class FetchAssetsRequest(BaseModel):
    types: list[str] = Field(default_factory=list)
    page: int = 1
    page_size: int = 42
    library_kind: AssetLibraryKind | None = None
    source_kind: AssetSourceKind | None = None
    media_type: AssetMediaFilter = "all"

    @field_validator("page")
    @classmethod
    def validate_page(cls, value: int | None) -> int:
        if value is None:
            return 1
        if value < 1:
            raise ValueError("page must be greater than or equal to 1")
        return value

    @field_validator("page_size")
    @classmethod
    def validate_page_size(cls, value: int | None) -> int:
        if value is None:
            return 42
        if value < 1 or value > 100:
            raise ValueError("page_size must be between 1 and 100")
        return value


class CreateAssetLibraryRequest(BaseModel):
    library_kind: AssetLibraryKind
    source_kind: Literal["uploaded"] = "uploaded"
    media_type: AssetMediaType
    url: str = Field(min_length=1, max_length=4096)
    thumbnail_url: str | None = Field(default=None, max_length=4096)
    name: str | None = Field(default=None, max_length=255)
    upload_context: Literal[
        "assets_page",
        "home_composer_slot",
        "home_composer_picker",
        "home_composer_attach",
        "agent_composer_picker",
        "agent_composer_attach",
        "canvas",
    ] | None = None
    resource_info: AssetResourceInfo | None = None
    aspect_ratio: str | None = Field(default=None, max_length=64)


class SinkAssetLibraryItemRequest(BaseModel):
    library_kind: AssetLibraryKind
    media_type: AssetMediaType
    url: str = Field(min_length=1, max_length=4096)
    thumbnail_url: str | None = Field(default=None, max_length=4096)
    name: str | None = Field(default=None, max_length=255)
    run_id: str | None = Field(default=None, max_length=255)
    node_id: str | None = Field(default=None, max_length=255)
    result_id: str | None = Field(default=None, max_length=255)
    classification_source: Literal["agent", "user_manual"] | None = None
    classification_role: str | None = Field(default=None, max_length=128)
    resource_info: AssetResourceInfo | None = None
    aspect_ratio: str | None = Field(default=None, max_length=64)


class SinkAssetLibraryRequest(BaseModel):
    items: list[SinkAssetLibraryItemRequest] = Field(min_length=1, max_length=100)


class AssetLibraryItemResponse(BaseModel):
    asset_id: str
    library_kind: AssetLibraryKind
    source_kind: Literal["uploaded"]
    media_type: AssetMediaType
    url: str
    thumbnail_url: str | None = None
    name: str | None = None
    upload_context: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime | None = None


class FetchResultAssetsItem(BaseModel):
    type: str
    node_id: str | None = None
    result: str | list[str] | None = None
    prompt: str | None = None
    model: str | None = None
    run_id: str | None = None
    created_at: datetime
    updated_at: datetime
    result_id: str
    metadata: dict[str, Any] | None = None


class AssetsMetaInfo(BaseModel):
    visible_total_count: int
    page_count: int
    hidden_count: int
    total_count: int
    subscription_level: int
    retention_days: int | None = None
    server_time: str


class FetchAssetsResponse(BaseModel):
    output: list[FetchResultAssetsItem]
    meta: AssetsMetaInfo


class SinkAssetLibraryItemResponse(BaseModel):
    asset_id: str
    library_kind: str
    source_kind: str = "generated"
    result_id: str


class SinkAssetLibraryResponse(BaseModel):
    sunk_count: int
    items: list[SinkAssetLibraryItemResponse]
