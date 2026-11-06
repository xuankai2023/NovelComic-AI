"""Image segmentation request and response shapes."""

from typing import Literal

from pydantic import BaseModel, Field, HttpUrl

ImageSegmentationReturnForm = Literal["crop", "mask", "whiteBK"]


class SegmentCommonImageRequest(BaseModel):
    image_url: HttpUrl
    return_form: ImageSegmentationReturnForm | None = Field(default=None)


class SegmentCommonImageResponse(BaseModel):
    source_image_url: str
    result_url: str
    object_key: str
    return_form: ImageSegmentationReturnForm | None = None
    provider: str
    provider_request_id: str | None = None
    credits_charged: int
