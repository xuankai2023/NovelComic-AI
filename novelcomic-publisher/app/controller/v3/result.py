"""画布节点历史结果读取和修改。查询条件里的 user_id 来自验签后的 sub。"""

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.common.exception.exception_share import ShareError
from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.services.share import ShareService

router = APIRouter()
_NOT_FOUND = 1010


class BatchFetchNodeResultsRequest(BaseModel):
    workflow_id: str
    node_ids: list[str] = Field(default_factory=list)
    share_id: str | None = None
    user_id: str | None = None


class UpdateResultRequest(BaseModel):
    flow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    result_id: str = Field(min_length=1)
    result: str
    user_id: str | None = None


def _public_result(item: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in item.items():
        output[key] = value.isoformat() if isinstance(value, datetime) else value
    return output


def _ok(data: Any) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _not_found() -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"code": _NOT_FOUND, "msg": "Result not found", "data": None},
    )


def _share_error(exc: ShareError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.response_code, "msg": str(exc), "data": None},
    )


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


@router.post("/all_batch_fetch", summary="批量读取节点最新结果")
async def batch_fetch_latest_results(
    body: BatchFetchNodeResultsRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    body.user_id = user.user_id
    query_user_id = user.user_id
    result_map: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in body.node_ids}
    if body.share_id:
        try:
            share = await ShareService.visit_share(
                database=_database(request),
                share_id=body.share_id,
                user_email=user.email,
            )
        except ShareError as exc:
            return _share_error(exc)
        if share.get("flow_id") != body.workflow_id:
            return _ok(result_map)
        owner_user_id = share.get("owner_user_id")
        if not isinstance(owner_user_id, str) or not owner_user_id:
            return _ok(result_map)
        query_user_id = owner_user_id
    if not body.node_ids:
        return _ok(result_map)

    database = _database(request)
    cursor = database["node_results"].find(
        {
            "workflow_id": body.workflow_id,
            "node_id": {"$in": body.node_ids},
            "user_id": query_user_id,
        },
        {"_id": 0, "user_id": 0},
    ).sort("created_at", -1)

    async for item in cursor:
        node_id = item.get("node_id")
        if node_id in result_map and not result_map[node_id]:
            result_map[node_id].append(_public_result(item))

    return _ok(result_map)


@router.patch("", summary="修改当前用户的节点结果")
async def update_result_content(
    body: UpdateResultRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    body.user_id = user.user_id
    database = _database(request)
    updated = await database["node_results"].update_one(
        {
            "workflow_id": body.flow_id,
            "node_id": body.node_id,
            "result_id": body.result_id,
            "user_id": body.user_id,
        },
        {"$set": {"result": body.result, "updated_at": datetime.now(UTC)}},
    )
    if not updated.matched_count:
        return _not_found()
    return _ok(None)
