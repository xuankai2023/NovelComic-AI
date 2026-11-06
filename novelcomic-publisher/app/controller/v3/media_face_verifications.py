"""Media face verification endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.media_face_verification import (
    FetchMediaFaceVerificationsRequest,
    IngestMediaFaceVerificationRequest,
)
from app.services.media_face_verification import (
    MediaFaceVerificationService,
    MediaFaceVerificationServiceError,
)

router = APIRouter()
_CLIENT_ERROR = 1003


def _ok(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _fail(msg: str, http_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=http_code,
        content={"code": _CLIENT_ERROR, "msg": msg, "data": None},
    )


@router.post("/ingest", summary="媒体真人检测入库并触发轮询")
async def ingest_media_face_verification(
    body: IngestMediaFaceVerificationRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        result = await MediaFaceVerificationService.ingest(
            database=database,
            request=body,
            user_id=user.user_id,
        )
    except MediaFaceVerificationServiceError as exc:
        return _fail(str(exc), exc.status_code)
    return _ok(result.model_dump(mode="json"))


@router.post("/status", summary="批量查询媒体真人检测状态")
async def fetch_media_face_verification_status(
    body: FetchMediaFaceVerificationsRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    result = await MediaFaceVerificationService.fetch_status(
        database=database,
        request=body,
        user_id=user.user_id,
    )
    return _ok(result.model_dump(mode="json"))
