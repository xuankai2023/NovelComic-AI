"""Update App Flow request shape."""

from pydantic import BaseModel, Field


class UpdateAppFlowRequest(BaseModel):
    sync_workflow: bool = False
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    demo_image_urls: list[str] | None = None
    visible_nodes: list[str] | None = None
    app_mode_config: dict[str, object] | None = None
