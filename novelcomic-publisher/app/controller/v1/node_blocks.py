"""Reusable canvas node blocks endpoints (/api/v1/node_blocks/*)."""

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
NODE_BLOCKS_COLLECTION = "node_blocks"


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


class CreateNodeBlockBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    thumbnail_url: str | None = None
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class UpdateNodeBlockBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    thumbnail_url: str | None = None
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None


@router.post("", summary="创建节点块")
async def create_node_block_endpoint(
    request: Request,
    body: CreateNodeBlockBody,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    now = datetime.now(UTC).isoformat()
    block_id = f"nb_{uuid4().hex[:16]}"
    doc = {
        "block_id": block_id,
        "user_id": user.user_id,
        "name": body.name.strip(),
        "description": body.description.strip(),
        "thumbnail_url": body.thumbnail_url,
        "nodes": body.nodes,
        "edges": body.edges,
        "created_at": now,
        "updated_at": now,
    }
    await _database(request)[NODE_BLOCKS_COLLECTION].insert_one(dict(doc))
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": doc})


@router.get("/page", summary="分页列出当前用户的节点块")
async def list_node_blocks_page_endpoint(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    keyword: str | None = Query(default=None),
) -> JSONResponse:
    database = _database(request)
    query: dict[str, Any] = {"user_id": user.user_id}
    if keyword and keyword.strip():
        query["name"] = {"$regex": keyword.strip(), "$options": "i"}

    total = int(await database[NODE_BLOCKS_COLLECTION].count_documents(query))
    skip = (page - 1) * page_size
    cursor = (
        database[NODE_BLOCKS_COLLECTION]
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


@router.patch("/{block_id}", summary="更新节点块")
async def update_node_block_endpoint(
    block_id: str,
    request: Request,
    body: UpdateNodeBlockBody,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = _database(request)
    updates: dict[str, Any] = {"updated_at": datetime.now(UTC).isoformat()}
    if body.name is not None:
        updates["name"] = body.name.strip()
    if body.description is not None:
        updates["description"] = body.description.strip()
    if body.thumbnail_url is not None:
        updates["thumbnail_url"] = body.thumbnail_url
    if body.nodes is not None:
        updates["nodes"] = body.nodes
    if body.edges is not None:
        updates["edges"] = body.edges

    result = await database[NODE_BLOCKS_COLLECTION].update_one(
        {"block_id": block_id, "user_id": user.user_id},
        {"$set": updates},
    )
    if not getattr(result, "matched_count", 0):
        return JSONResponse(
            status_code=404,
            content={"code": 1004, "msg": "Node block not found", "data": None},
        )
    doc = await database[NODE_BLOCKS_COLLECTION].find_one(
        {"block_id": block_id, "user_id": user.user_id},
        {"_id": 0},
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": doc})


@router.delete("/{block_id}", summary="删除节点块")
async def delete_node_block_endpoint(
    block_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    result = await _database(request)[NODE_BLOCKS_COLLECTION].delete_one(
        {"block_id": block_id, "user_id": user.user_id}
    )
    if not getattr(result, "deleted_count", 0):
        return JSONResponse(
            status_code=404,
            content={"code": 1004, "msg": "Node block not found", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": {"deleted": True}})
