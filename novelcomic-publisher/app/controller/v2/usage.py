"""Usage and credit-income history endpoints."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser

router = APIRouter()


def _database(request: Request):
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.get("/history", summary="获取用量历史")
async def usage_history(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    data = await _read_page(
        _database(request),
        collection_name="usage_v2",
        query={"user_id": user.user_id},
        page=page,
        page_size=page_size,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.get("/income", summary="获取积分入账历史")
async def credit_income_history(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    data = await _read_page(
        _database(request),
        collection_name="credits_inout_record",
        query={"user_id": user.user_id, "direction": "in"},
        page=page,
        page_size=page_size,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


async def _read_page(
    database,
    *,
    collection_name: str,
    query: dict,
    page: int,
    page_size: int,
) -> dict:
    collection = database[collection_name]
    cursor = (
        collection.find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    items = [_serialize_document(item) for item in await _cursor_to_list(cursor, page_size)]
    total = await collection.count_documents(query)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def _cursor_to_list(cursor, length: int) -> list[dict]:
    if hasattr(cursor, "to_list"):
        return await cursor.to_list(length=length)
    return list(cursor)


def _serialize_document(document: dict) -> dict:
    return {key: _serialize_value(value) for key, value in document.items() if key != "_id"}


def _serialize_value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return _serialize_document(value)
    if isinstance(value, list):
        return [_serialize_value(item) for item in value]
    return value
