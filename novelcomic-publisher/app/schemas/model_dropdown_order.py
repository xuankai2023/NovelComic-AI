"""Model dropdown grouping and response shapes."""

from typing import Any, Literal

from pydantic import BaseModel, Field

DropdownGroupName = Literal[
    "atom",
    "text_to_image",
    "image_to_image",
    "text_to_video",
    "image_to_video",
    "all_round_video",
]
MediaKind = Literal["image", "video"]

DROPDOWN_GROUP_NAMES: tuple[str, ...] = (
    "atom",
    "text_to_image",
    "image_to_image",
    "text_to_video",
    "image_to_video",
    "all_round_video",
)

DROPDOWN_GROUP_META: dict[str, dict[str, Any]] = {
    "atom": {
        "media_kind": "image",
        "frontend_category": "text",
        "config_names": ["text_generator_config"],
    },
    "text_to_image": {
        "media_kind": "image",
        "frontend_category": "image",
        "config_names": ["text_to_image_config"],
    },
    "image_to_image": {
        "media_kind": "image",
        "frontend_category": "imageToImage",
        "config_names": ["image_to_image_config"],
    },
    "text_to_video": {
        "media_kind": "video",
        "frontend_category": "textToVideo",
        "config_names": ["text_to_video_config"],
    },
    "image_to_video": {
        "media_kind": "video",
        "frontend_category": "video",
        "config_names": ["image_to_video_config"],
    },
    "all_round_video": {
        "media_kind": "video",
        "frontend_category": "video",
        "config_names": ["media_to_video_config"],
    },
}

CONFIG_NAME_TO_GROUP: dict[str, str] = {
    config_name: group
    for group, meta in DROPDOWN_GROUP_META.items()
    for config_name in meta["config_names"]
}

DEFAULT_IMAGE_BRANDS: list[str] = [
    "gpt",
    "nanobanana",
    "midjourney",
    "seedream",
    "grok",
    "qwen",
    "flux",
]
DEFAULT_VIDEO_BRANDS: list[str] = [
    "seedance",
    "kling",
    "veo",
    "happy_horse",
    "sora",
    "hailuo",
    "wan",
    "vidu",
    "runway",
    "luma",
    "grok_imagine_video",
]


class BrandOrder(BaseModel):
    image: list[str] = Field(default_factory=lambda: list(DEFAULT_IMAGE_BRANDS))
    video: list[str] = Field(default_factory=lambda: list(DEFAULT_VIDEO_BRANDS))


class DropdownModelItem(BaseModel):
    config_name: str
    model_id: str
    display_name: str
    brand: str | None = None
    released_at: str | None = None
    sort_in_brand: int = 0
    dropdown_groups: list[str] | None = None
    pricing: Any = None
    params: dict[str, Any] = Field(default_factory=dict)
    input_mapping: dict[str, Any] | None = None


class DropdownGroup(BaseModel):
    group: str
    media_kind: MediaKind
    frontend_category: str
    models: list[DropdownModelItem] = Field(default_factory=list)


class DropdownOrderResponse(BaseModel):
    brand_order: BrandOrder
    groups: dict[str, DropdownGroup]
