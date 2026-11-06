"""Developer API v1 router (/api/developer/v1/*)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.developer_api.middleware.api_key_auth import get_authenticated_api_client
from app.developer_api.services.workflow_runs import DeveloperWorkflowService

developer_v1_router = APIRouter(prefix="/api/developer/v1", tags=["Developer API"])


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


class CreateDeveloperWorkflowBody(BaseModel):
    project_name: str = Field(default="Untitled Workflow", min_length=1, max_length=120)
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class CreateDeveloperWorkflowFromTemplateBody(BaseModel):
    template_id: str = Field(min_length=1)
    project_name: str | None = None


class PatchDeveloperWorkflowBody(BaseModel):
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None
    parameters: dict[str, Any] | None = None


class StartDeveloperWorkflowRunBody(BaseModel):
    parameters: dict[str, Any] | None = None
    start_ids: list[str] = Field(default_factory=list)
    end_ids: list[str] = Field(default_factory=list)
    client_request_id: str | None = None


class SubmitDeveloperSelectionBody(BaseModel):
    user_selection: dict[str, Any] = Field(default_factory=dict)
    start_ids: list[str] = Field(default_factory=list)
    command_id: str | None = None


class CancelDeveloperWorkflowRunBody(BaseModel):
    command_id: str | None = None


@developer_v1_router.get("/templates", summary="搜索公开工作流模板")
async def developer_list_templates(
    request: Request,
    _client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
    keyword: str | None = Query(default=None),
    page_number: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    page = await DeveloperWorkflowService.list_templates(
        _database(request),
        keyword=keyword,
        page_number=page_number,
        page_size=page_size,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": page})


@developer_v1_router.post("/workflows", summary="创建新工作流")
async def developer_create_workflow(
    request: Request,
    body: CreateDeveloperWorkflowBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    project = await DeveloperWorkflowService.create_workflow(
        _database(request),
        client=client,
        project_name=body.project_name,
        nodes=body.nodes,
        edges=body.edges,
    )
    return JSONResponse(status_code=201, content={"code": 200, "msg": "ok", "data": project})


@developer_v1_router.post("/workflows/from-template", summary="从模板创建工作流")
async def developer_create_workflow_from_template(
    request: Request,
    body: CreateDeveloperWorkflowFromTemplateBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    project = await DeveloperWorkflowService.create_workflow_from_template(
        _database(request),
        client=client,
        template_id=body.template_id,
        project_name=body.project_name,
    )
    return JSONResponse(status_code=201, content={"code": 200, "msg": "ok", "data": project})


@developer_v1_router.get("/workflows/{flow_id}", summary="读取工作流定义")
async def developer_get_workflow(
    flow_id: str,
    request: Request,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    project = await DeveloperWorkflowService.get_workflow(
        _database(request),
        client=client,
        flow_id=flow_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": project})


@developer_v1_router.patch("/workflows/{flow_id}", summary="局部修改工作流")
async def developer_patch_workflow(
    flow_id: str,
    request: Request,
    body: PatchDeveloperWorkflowBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    project = await DeveloperWorkflowService.patch_workflow(
        _database(request),
        client=client,
        flow_id=flow_id,
        nodes=body.nodes,
        edges=body.edges,
        parameters=body.parameters,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": project})


@developer_v1_router.get("/workflows/{flow_id}/parameters", summary="读取工作流可配置参数")
async def developer_get_workflow_parameters(
    flow_id: str,
    request: Request,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    params = await DeveloperWorkflowService.get_workflow_parameters(
        _database(request),
        client=client,
        flow_id=flow_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": params})


@developer_v1_router.post("/workflows/{flow_id}/runs", summary="启动工作流执行")
async def developer_start_workflow_run(
    flow_id: str,
    request: Request,
    body: StartDeveloperWorkflowRunBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.start_workflow_run(
        _database(request),
        request.app.state.connections.redis,
        client=client,
        flow_id=flow_id,
        parameters=body.parameters,
        start_ids=body.start_ids,
        end_ids=body.end_ids,
        client_request_id=body.client_request_id,
    )
    return JSONResponse(status_code=202, content={"code": 200, "msg": "ok", "data": result})


@developer_v1_router.get("/workflow-runs/{task_id}", summary="查询运行状态")
async def developer_get_workflow_run(
    task_id: str,
    request: Request,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.get_workflow_run(
        _database(request),
        client=client,
        task_id=task_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": result})


@developer_v1_router.get("/workflow-runs/{task_id}/results", summary="读取运行产物结果")
async def developer_get_workflow_run_results(
    task_id: str,
    request: Request,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.get_workflow_run_results(
        _database(request),
        client=client,
        task_id=task_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": result})


@developer_v1_router.get("/workflow-runs/{task_id}/selection", summary="读取待人工选择项")
async def developer_get_workflow_run_selection(
    task_id: str,
    request: Request,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.get_workflow_run_selection(
        _database(request),
        client=client,
        task_id=task_id,
    )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": result})


@developer_v1_router.post("/workflow-runs/{task_id}/selection", summary="提交选择并继续")
async def developer_submit_workflow_run_selection(
    task_id: str,
    request: Request,
    body: SubmitDeveloperSelectionBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.submit_workflow_run_selection(
        _database(request),
        request.app.state.connections.redis,
        client=client,
        task_id=task_id,
        user_selection=body.user_selection,
        start_ids=body.start_ids,
        command_id=body.command_id,
    )
    return JSONResponse(status_code=202, content={"code": 200, "msg": "ok", "data": result})


@developer_v1_router.post("/workflow-runs/{task_id}/cancel", summary="取消运行")
async def developer_cancel_workflow_run(
    task_id: str,
    request: Request,
    body: CancelDeveloperWorkflowRunBody,
    client: Annotated[dict[str, Any], Depends(get_authenticated_api_client)],
) -> JSONResponse:
    result = await DeveloperWorkflowService.cancel_workflow_run(
        _database(request),
        request.app.state.connections.redis,
        client=client,
        task_id=task_id,
        command_id=body.command_id,
    )
    return JSONResponse(status_code=202, content={"code": 200, "msg": "ok", "data": result})
