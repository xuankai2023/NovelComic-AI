"""Account view of Developer API tasks (/api/v1/task/api_client/list)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.database.mongo import DEVELOPER_WORKFLOW_RUN
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser

router = APIRouter()


@router.get("/api_client/list", summary="查询当前账户下所有 Developer API Key 的任务记录")
async def list_developer_api_client_tasks_endpoint(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    client_id: str | None = Query(default=None),
) -> JSONResponse:
    settings = get_settings()
    database = request.app.state.connections.mongo[settings.mongo_database]
    query: dict[str, Any] = {"owner_user_id": user.user_id}
    if client_id:
        query["client_id"] = client_id

    total = int(await database[DEVELOPER_WORKFLOW_RUN].count_documents(query))
    skip = (page - 1) * page_size
    cursor = (
        database[DEVELOPER_WORKFLOW_RUN]
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(page_size)
    )
    if hasattr(cursor, "to_list"):
        items = await cursor.to_list(length=page_size)
    else:
        items = list(cursor)
    serialized: list[dict[str, Any]] = []
    for item in items:
        row = dict(item)
        for k, v in list(row.items()):
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
        serialized.append(row)
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {
                "list": serialized,
                "total": total,
                "page": page,
                "page_size": page_size,
            },
        },
    )
