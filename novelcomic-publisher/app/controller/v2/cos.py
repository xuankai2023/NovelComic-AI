"""COS browser direct upload endpoints."""

from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.utils.cos import (
    DEFAULT_COS_PRESIGN_EXPIRES_IN,
    a_generate_cos_presigned_put_url,
    build_cos_object_key,
    get_cos_cdn_url,
)

router = APIRouter()


class PresignRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=255)
    file_type: Literal["image", "video", "audio", "file"] | None = None


class PresignResponse(BaseModel):
    presigned_url: str
    object_key: str
    cdn_url: str
    expires_in: int


@router.post("/presign", summary="获取 COS PUT 预签名 URL")
async def get_cos_presigned_url(body: PresignRequest) -> JSONResponse:
    object_key = build_cos_object_key(filename=body.filename, file_type=body.file_type)
    presigned_url = await a_generate_cos_presigned_put_url(
        object_key=object_key,
        content_type=body.content_type or "application/octet-stream",
    )
    data = PresignResponse(
        presigned_url=presigned_url,
        object_key=object_key,
        cdn_url=get_cos_cdn_url(object_key),
        expires_in=DEFAULT_COS_PRESIGN_EXPIRES_IN,
    ).model_dump()
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})
