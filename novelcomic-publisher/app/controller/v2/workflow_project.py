"""读取和更新当前用户的 flow project。"""

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.workflow_project import (
    SaveWorkflowProjectRequest,
    UpdateWorkflowProjectDetailsRequest,
    UpdateWorkflowProjectRequest,
    WorkflowProjectResponse,
)
from app.services.flow import FlowService

router = APIRouter()
_NOT_FOUND = 1010


def _ok(data: dict[str, Any], status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": 200, "msg": "ok", "data": data})


def _not_found() -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"code": _NOT_FOUND, "msg": "Flow project not found", "data": None},
    )


def _dump_project(project: dict[str, Any]) -> dict[str, Any]:
    return WorkflowProjectResponse(**project).model_dump(mode="json")


@router.post("/project", summary="保存 workflow project")
async def save_workflow_project(
    body: SaveWorkflowProjectRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    project = await FlowService.save_workflow_project(
        database=database,
        req=body,
        user_id=user.user_id,
    )
    return _ok(project.model_dump(mode="json"), status_code=201)


@router.patch("/project", summary="按当前用户更新 nodes / edges")
async def update_workflow_project(
    body: UpdateWorkflowProjectRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    asyncio.create_task(
        FlowService.update_workflow_project_without_response(
            database=database,
            req=body,
            user_id=user.user_id,
        )
    )
    return _ok({})


@router.patch("/project/details", summary="只更新封面和项目详情")
async def update_workflow_project_details(
    body: UpdateWorkflowProjectDetailsRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    asyncio.create_task(
        FlowService.update_workflow_project_details_without_response(
            database=database,
            req=body,
            user_id=user.user_id,
        )
    )
    return _ok({})


@router.get("/project/{flow_id}", summary="读取当前用户的 flow project")
async def get_workflow_project(
    flow_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    project = await FlowService.get_workflow_project(
        database=database,
        flow_id=flow_id,
        user_id=user.user_id,
    )
    if project is None:
        return _not_found()

    project["last_view_time"] = await FlowService.update_workflow_project_last_view_time(
        database=database,
        flow_id=flow_id,
        user_id=user.user_id,
    )
    project.pop("user_id", None)
    return _ok(_dump_project(project))
