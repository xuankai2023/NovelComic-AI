"""Miniapp task endpoints (/api/v1/miniapp/*)."""

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser

router = APIRouter()
MINIAPP_TASK_COLLECTION = "miniapp_task"


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


class CreateMiniappTaskBody(BaseModel):
    miniapp_id: str = Field(min_length=1, max_length=64)
    flow_id: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/create_task", summary="创建小程序任务")
async def create_miniapp_task_endpoint(
    request: Request,
    body: CreateMiniappTaskBody,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    now = datetime.now(UTC).isoformat()
    task_id = f"mat_{uuid4().hex[:16]}"
    doc = {
        "task_id": task_id,
        "miniapp_id": body.miniapp_id,
        "flow_id": body.flow_id,
        "user_id": user.user_id,
        "inputs": body.inputs,
        "status": "pending",
        "outputs": [],
        "created_at": now,
        "updated_at": now,
    }
    await _database(request)[MINIAPP_TASK_COLLECTION].insert_one(dict(doc))
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": doc})


@router.get("/get_task/{task_id}", summary="查询单个小程序任务结果")
async def get_miniapp_task_endpoint(
    task_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    doc = await _database(request)[MINIAPP_TASK_COLLECTION].find_one(
        {"task_id": task_id, "user_id": user.user_id},
        {"_id": 0},
    )
    if doc is None:
        return JSONResponse(
            status_code=404,
            content={"code": 1004, "msg": "Miniapp task not found", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": dict(doc)})


@router.get("/get_list/{miniapp_id}", summary="按 miniapp_id 查询当前用户的任务列表")
async def list_miniapp_tasks_by_app_endpoint(
    miniapp_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = _database(request)
    query = {"miniapp_id": miniapp_id, "user_id": user.user_id}
    total = int(await database[MINIAPP_TASK_COLLECTION].count_documents(query))
    skip = (page - 1) * page_size
    cursor = (
        database[MINIAPP_TASK_COLLECTION]
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(page_size)
    )
    if hasattr(cursor, "to_list"):
        items = await cursor.to_list(length=page_size)
    else:
        items = list(cursor)
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {
                "list": [dict(item) for item in items],
                "total": total,
                "page": page,
                "page_size": page_size,
            },
        },
    )


@router.get("/get_list", summary="查询当前用户的所有小程序任务列表")
async def list_all_miniapp_tasks_endpoint(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = _database(request)
    query = {"user_id": user.user_id}
    total = int(await database[MINIAPP_TASK_COLLECTION].count_documents(query))
    skip = (page - 1) * page_size
    cursor = (
        database[MINIAPP_TASK_COLLECTION]
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(page_size)
    )
    if hasattr(cursor, "to_list"):
        items = await cursor.to_list(length=page_size)
    else:
        items = list(cursor)
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {
                "list": [dict(item) for item in items],
                "total": total,
                "page": page,
                "page_size": page_size,
            },
        },
    )
