from typing import Literal

from pydantic import BaseModel, Field


class SocialPostRequestItem(BaseModel):
    integration: Literal["tiktok", "youtube", "x"] = Field(
        description="Social media platform for posting content."
    )
    text: str = Field(default="", description="Text content or title for the post.")
    description: str = Field(default="", description="Description for platforms that support it.")
    video_url: str = Field(default="", description="URL of the video to post.")
    result_id: str | None = Field(default=None, description="Optional workflow result id.")


class SocialPostRequest(BaseModel):
    post_items: list[SocialPostRequestItem] = Field(default_factory=list)
