"""Developer API (/api/developer/v1/*) workflow, template, and workflow-run service."""

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from app.dao.flow import FlowDao
from app.dao.template import TemplateDao
from app.database.mongo import DEVELOPER_WORKFLOW_RUN, FLOW_TASK
from app.schemas.workflow_project import SaveWorkflowProjectRequest, UpdateWorkflowProjectRequest
from app.schemas.workflow_runs_v2 import (
    ContinueWorkflowRunRequest,
    CreateWorkflowRunRequest,
)
from app.services.flow import FlowService
from app.services.workflow_runs_v2 import (
    WorkflowRunConflict,
    WorkflowRunInvalid,
    WorkflowRunV2Service,
)


def _check_flow_access(client: dict[str, Any], flow_id: str) -> None:
    allowed = client.get("allowed_flow_ids")
    if isinstance(allowed, list) and len(allowed) > 0 and flow_id not in allowed:
        raise HTTPException(status_code=403, detail="API client is not allowed to access this workflow")


def _extract_parameters(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parameters: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        node_type = str(node.get("type") or "")
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        label = str(data.get("label") or data.get("title") or node_type or node_id)
        if node_type in {"textInput", "imageInput", "videoInput", "audioInput"} or "prompt" in data:
            parameters.append(
                {
                    "node_id": node_id,
                    "node_type": node_type,
                    "label": label,
                    "prompt": data.get("prompt") or data.get("text") or "",
                    "url": data.get("url") or data.get("imageUrl") or data.get("videoUrl") or "",
                    "selectedModels": data.get("selectedModels") or [],
                }
            )
    return parameters


def _apply_parameter_overrides(
    nodes: list[dict[str, Any]],
    parameters: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not parameters or not isinstance(parameters, dict):
        return nodes
    updated_nodes: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            updated_nodes.append(node)
            continue
        node_copy = dict(node)
        node_id = str(node_copy.get("id") or "")
        override = parameters.get(node_id)
        if override is not None:
            data = dict(node_copy.get("data") or {})
            if isinstance(override, dict):
                data.update(override)
            elif isinstance(override, str):
                data["prompt"] = override
                data["text"] = override
            node_copy["data"] = data
        updated_nodes.append(node_copy)
    return updated_nodes


class DeveloperWorkflowService:
    @staticmethod
    async def list_templates(
        database: Any,
        *,
        keyword: str | None = None,
        page_number: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        return await TemplateDao.get_template_page(
            database,
            keyword=keyword,
            page_number=page_number,
            page_size=page_size,
        )

    @staticmethod
    async def create_workflow(
        database: Any,
        *,
        client: dict[str, Any],
        project_name: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
    ) -> dict[str, Any]:
        req = SaveWorkflowProjectRequest(
            project_name=project_name,
            nodes=nodes,
            edges=edges,
        )
        project = await FlowService.save_workflow_project(
            database=database,
            req=req,
            user_id=str(client["owner_user_id"]),
        )
        return project.model_dump(mode="json")

    @staticmethod
    async def create_workflow_from_template(
        database: Any,
        *,
        client: dict[str, Any],
        template_id: str,
        project_name: str | None = None,
    ) -> dict[str, Any]:
        tpl = await TemplateDao.get_template_by_id(database, template_id)
        if tpl is None:
            raise HTTPException(status_code=404, detail="Template not found")
        raw_name = tpl.get("name")
        if isinstance(raw_name, dict):
            default_name = str(raw_name.get("en") or raw_name.get("zh") or "Untitled Workflow")
        else:
            default_name = str(raw_name or tpl.get("title") or "Untitled Workflow")
        name = project_name or default_name
        nodes = tpl.get("nodes") if isinstance(tpl.get("nodes"), list) else []
        edges = tpl.get("edges") if isinstance(tpl.get("edges"), list) else []
        req = SaveWorkflowProjectRequest(
            project_name=name,
            nodes=nodes,
            edges=edges,
            parent_flow_id=str(tpl.get("flow_id") or template_id),
        )
        project = await FlowService.save_workflow_project(
            database=database,
            req=req,
            user_id=str(client["owner_user_id"]),
        )
        return project.model_dump(mode="json")

    @staticmethod
    async def get_workflow(
        database: Any,
        *,
        client: dict[str, Any],
        flow_id: str,
    ) -> dict[str, Any]:
        _check_flow_access(client, flow_id)
        project = await FlowDao.get_workflow_project(
            database,
            flow_id=flow_id,
            user_id=str(client["owner_user_id"]),
        )
        if project is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        project = dict(project)
        project.pop("_id", None)
        project.pop("user_id", None)
        for k, v in list(project.items()):
            if isinstance(v, datetime):
                project[k] = v.isoformat()
        if isinstance(project.get("details"), dict):
            details = dict(project["details"])
            for k, v in list(details.items()):
                if isinstance(v, datetime):
                    details[k] = v.isoformat()
            project["details"] = details
        return project

    @staticmethod
    async def patch_workflow(
        database: Any,
        *,
        client: dict[str, Any],
        flow_id: str,
        nodes: list[dict[str, Any]] | None = None,
        edges: list[dict[str, Any]] | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        project = await DeveloperWorkflowService.get_workflow(
            database,
            client=client,
            flow_id=flow_id,
        )
        next_nodes = nodes if nodes is not None else list(project.get("nodes") or [])
        next_edges = edges if edges is not None else list(project.get("edges") or [])
        if parameters:
            next_nodes = _apply_parameter_overrides(next_nodes, parameters)
        req = UpdateWorkflowProjectRequest(
            flow_id=flow_id,
            nodes=next_nodes,
            edges=next_edges,
        )
        await FlowService.update_workflow_project_without_response(
            database=database,
            req=req,
            user_id=str(client["owner_user_id"]),
        )
        project["nodes"] = next_nodes
        project["edges"] = next_edges
        return project

    @staticmethod
    async def get_workflow_parameters(
        database: Any,
        *,
        client: dict[str, Any],
        flow_id: str,
    ) -> list[dict[str, Any]]:
        project = await DeveloperWorkflowService.get_workflow(
            database,
            client=client,
            flow_id=flow_id,
        )
        return _extract_parameters(project.get("nodes") or [])

    @staticmethod
    async def start_workflow_run(
        database: Any,
        redis_client: Any,
        *,
        client: dict[str, Any],
        flow_id: str,
        parameters: dict[str, Any] | None = None,
        start_ids: list[str] | None = None,
        end_ids: list[str] | None = None,
        client_request_id: str | None = None,
    ) -> dict[str, Any]:
        project = await DeveloperWorkflowService.get_workflow(
            database,
            client=client,
            flow_id=flow_id,
        )
        nodes = _apply_parameter_overrides(list(project.get("nodes") or []), parameters)
        edges = list(project.get("edges") or [])
        req_id = client_request_id or f"dev_{uuid4().hex}"
        create_req = CreateWorkflowRunRequest(
            client_request_id=req_id,
            command_id=req_id,
            flow_id=flow_id,
            flow_task={"nodes": nodes, "edges": edges},
            start_ids=start_ids or [],
            end_ids=end_ids or [],
        )
        try:
            run = await WorkflowRunV2Service.create_run(
                database=database,
                redis_client=redis_client,
                request=create_req,
                user_id=str(client["owner_user_id"]),
            )
        except WorkflowRunInvalid as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except WorkflowRunConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        task_id = f"TASK_{run.flow_task_id}"
        now = datetime.now(UTC)
        dev_task_doc = {
            "task_id": task_id,
            "flow_task_id": run.flow_task_id,
            "flow_run_id": run.flow_run_id,
            "flow_id": flow_id,
            "client_id": client["client_id"],
            "client_name": client.get("name") or "",
            "owner_user_id": str(client["owner_user_id"]),
            "status": run.status,
            "created_at": now,
            "updated_at": now,
        }
        await database[DEVELOPER_WORKFLOW_RUN].update_one(
            {"task_id": task_id},
            {"$set": dev_task_doc},
            upsert=True,
        )
        return {
            "task_id": task_id,
            "flow_task_id": run.flow_task_id,
            "flow_run_id": run.flow_run_id,
            "flow_id": flow_id,
            "status": run.status,
            "created_at": now.isoformat(),
        }

    @staticmethod
    async def _resolve_task(
        database: Any,
        *,
        client: dict[str, Any],
        task_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        normalized_flow_task_id = task_id[5:] if task_id.startswith("TASK_") else task_id
        dev_task = await database[DEVELOPER_WORKFLOW_RUN].find_one(
            {
                "$or": [{"task_id": task_id}, {"flow_task_id": normalized_flow_task_id}],
                "owner_user_id": str(client["owner_user_id"]),
            }
        )
        flow_task_id = (
            str(dev_task["flow_task_id"])
            if dev_task is not None and dev_task.get("flow_task_id")
            else normalized_flow_task_id
        )
        run = await database[FLOW_TASK].find_one(
            {"flow_task_id": flow_task_id, "user_id": str(client["owner_user_id"])}
        )
        if run is None:
            raise HTTPException(status_code=404, detail="Workflow run not found")
        return dev_task or {"task_id": f"TASK_{flow_task_id}", "flow_task_id": flow_task_id}, dict(run)

    @staticmethod
    async def get_workflow_run(
        database: Any,
        *,
        client: dict[str, Any],
        task_id: str,
    ) -> dict[str, Any]:
        dev_task, run = await DeveloperWorkflowService._resolve_task(
            database,
            client=client,
            task_id=task_id,
        )
        created_at = run.get("created_at")
        updated_at = run.get("updated_at")
        return {
            "task_id": dev_task.get("task_id") or f"TASK_{run['flow_task_id']}",
            "flow_task_id": run["flow_task_id"],
            "flow_run_id": run.get("flow_run_id") or "",
            "flow_id": run.get("flow_id"),
            "status": run.get("status") or "pending",
            "created_at": created_at.isoformat() if isinstance(created_at, datetime) else created_at,
            "updated_at": updated_at.isoformat() if isinstance(updated_at, datetime) else updated_at,
        }

    @staticmethod
    async def get_workflow_run_results(
        database: Any,
        *,
        client: dict[str, Any],
        task_id: str,
    ) -> dict[str, Any]:
        dev_task, run = await DeveloperWorkflowService._resolve_task(
            database,
            client=client,
            task_id=task_id,
        )
        flow_task = run.get("flow_task") if isinstance(run.get("flow_task"), dict) else {}
        nodes = flow_task.get("nodes") if isinstance(flow_task.get("nodes"), list) else []
        node_results: list[dict[str, Any]] = []
        for node in nodes:
            if not isinstance(node, dict):
                continue
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            outputs = node.get("outputs") or data.get("outputs") or data.get("result")
            if outputs:
                node_results.append(
                    {
                        "node_id": node.get("id"),
                        "node_type": node.get("type"),
                        "outputs": outputs,
                    }
                )
        return {
            "task_id": dev_task.get("task_id") or f"TASK_{run['flow_task_id']}",
            "flow_task_id": run["flow_task_id"],
            "status": run.get("status") or "pending",
            "results": node_results,
        }

    @staticmethod
    async def get_workflow_run_selection(
        database: Any,
        *,
        client: dict[str, Any],
        task_id: str,
    ) -> dict[str, Any]:
        dev_task, run = await DeveloperWorkflowService._resolve_task(
            database,
            client=client,
            task_id=task_id,
        )
        return {
            "task_id": dev_task.get("task_id") or f"TASK_{run['flow_task_id']}",
            "flow_task_id": run["flow_task_id"],
            "flow_run_id": run.get("flow_run_id") or "",
            "status": run.get("status") or "pending",
            "waiting_for_selection": run.get("status") == "waiting_for_selection",
            "user_selection": run.get("user_selection") or {},
        }

    @staticmethod
    async def submit_workflow_run_selection(
        database: Any,
        redis_client: Any,
        *,
        client: dict[str, Any],
        task_id: str,
        user_selection: dict[str, Any],
        start_ids: list[str] | None = None,
        command_id: str | None = None,
    ) -> dict[str, Any]:
        dev_task, run = await DeveloperWorkflowService._resolve_task(
            database,
            client=client,
            task_id=task_id,
        )
        req = ContinueWorkflowRunRequest(
            command_id=command_id or f"dev_cont_{uuid4().hex}",
            flow_run_id=str(run.get("flow_run_id") or ""),
            flow_task=run.get("flow_task") or {"nodes": [], "edges": []},
            start_ids=start_ids or [],
            user_selection=user_selection,
        )
        try:
            updated = await WorkflowRunV2Service.continue_run(
                database=database,
                redis_client=redis_client,
                user_id=str(client["owner_user_id"]),
                flow_task_id=str(run["flow_task_id"]),
                request=req,
            )
        except WorkflowRunInvalid as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except WorkflowRunConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {
            "task_id": dev_task.get("task_id") or f"TASK_{updated.flow_task_id}",
            "flow_task_id": updated.flow_task_id,
            "flow_run_id": updated.flow_run_id,
            "status": updated.status,
        }

    @staticmethod
    async def cancel_workflow_run(
        database: Any,
        redis_client: Any,
        *,
        client: dict[str, Any],
        task_id: str,
        command_id: str | None = None,
    ) -> dict[str, Any]:
        dev_task, run = await DeveloperWorkflowService._resolve_task(
            database,
            client=client,
            task_id=task_id,
        )
        try:
            updated = await WorkflowRunV2Service.cancel_run(
                database=database,
                redis_client=redis_client,
                user_id=str(client["owner_user_id"]),
                flow_task_id=str(run["flow_task_id"]),
                command_id=command_id or f"dev_cancel_{uuid4().hex}",
            )
        except WorkflowRunInvalid as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except WorkflowRunConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {
            "task_id": dev_task.get("task_id") or f"TASK_{updated.flow_task_id}",
            "flow_task_id": updated.flow_task_id,
            "flow_run_id": updated.flow_run_id,
            "status": updated.status,
        }
