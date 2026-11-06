"""Personal asset library endpoints."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.assets import (
    AssetLibraryItemResponse,
    CreateAssetLibraryRequest,
    FetchAssetsRequest,
    FetchAssetsResponse,
    SinkAssetLibraryRequest,
    SinkAssetLibraryResponse,
)
from app.services.assets import AssetLibraryServiceError, AssetsService

router = APIRouter()
_CLIENT_ERROR = 1003
_NOT_FOUND = 1010
CATEGORY_TYPE_MAP = {
    "image": ["image"],
    "video": ["video"],
    "audio": ["audio"],
    "text": ["text", "splitText"],
    "cut": ["cut"],
}


def _ok(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _fail(msg: str, http_code: int = 400) -> JSONResponse:
    code = _NOT_FOUND if http_code == 404 else _CLIENT_ERROR
    return JSONResponse(status_code=http_code, content={"code": code, "msg": msg, "data": None})


@router.post("/fetch", summary="读取素材库或生成结果素材")
async def fetch_assets(
    body: FetchAssetsRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    category: str | None = Query(default=None),
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    if category in CATEGORY_TYPE_MAP:
        body.types = CATEGORY_TYPE_MAP[category]
    assets_data = await AssetsService.fetch_assets_page(
        database=database,
        params=body,
        user_id=user.user_id,
    )
    data = FetchAssetsResponse(**assets_data).model_dump(mode="json")
    return _ok(data)


@router.post("/library/sink", summary="把生成结果归档到个人素材库分类")
async def sink_generated_assets(
    body: SinkAssetLibraryRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        result = await AssetsService.sink_generated_assets(
            database=database,
            request=body,
            user_id=user.user_id,
        )
    except AssetLibraryServiceError as exc:
        return _fail(str(exc), exc.status_code)
    data = SinkAssetLibraryResponse(**result).model_dump(mode="json")
    return _ok(data)


@router.post("/library", summary="保存上传素材到个人素材库")
async def create_library_asset(
    body: CreateAssetLibraryRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        item = await AssetsService.create_uploaded_asset(
            database=database,
            request=body,
            user_id=user.user_id,
        )
    except AssetLibraryServiceError as exc:
        return _fail(str(exc), exc.status_code)
    data = AssetLibraryItemResponse(**item).model_dump(mode="json")
    return _ok(data)
