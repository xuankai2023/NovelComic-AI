"""内部工作流编辑。密钥通过后，资源主人来自请求体里的 user_id。"""

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.schemas.workflow_project import UpdateWorkflowProjectRequest
from app.services.flow import FlowService

router = APIRouter()
_CLIENT_ERROR = 1000


class EditWorkflowRequest(BaseModel):
    user_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


def _ok(data: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


def _fail(msg: str, http_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=http_code,
        content={"code": _CLIENT_ERROR, "msg": msg, "data": None},
    )


@router.post("/edit", summary="按请求体里的 user_id 更新 workflow")
async def edit_workflow(body: EditWorkflowRequest, request: Request) -> JSONResponse:
    user_id = body.user_id.strip()
    flow_id = body.flow_id.strip()
    if not user_id or not flow_id:
        return _fail("user_id is required" if not user_id else "flow_id is required")

    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        await FlowService.update_workflow_project_without_response(
            database=database,
            req=UpdateWorkflowProjectRequest(
                flow_id=flow_id,
                nodes=body.nodes,
                edges=body.edges,
            ),
            user_id=user_id,
        )
    except ValueError as exc:
        return _fail(str(exc))
    return _ok({"flow_id": flow_id})
