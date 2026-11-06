"""Image segmentation endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.image_segmentation import SegmentCommonImageRequest
from app.services.image_segmentation import ImageSegmentationService, ImageSegmentationServiceError

router = APIRouter()
_CLIENT_ERROR = 1003


def _ok(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _fail(msg: str, http_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=http_code,
        content={"code": _CLIENT_ERROR, "msg": msg, "data": None},
    )


@router.post("/common", summary="通用图片分割")
async def segment_common_image(
    body: SegmentCommonImageRequest,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    try:
        data = await ImageSegmentationService.segment_common_image(
            user_id=user.user_id,
            request=body,
        )
    except ImageSegmentationServiceError as exc:
        return _fail(str(exc), exc.status_code)
    return _ok(data.model_dump(mode="json"))
