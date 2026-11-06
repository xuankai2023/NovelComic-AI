from typing import Any

from fastapi import APIRouter, Depends, Request, status

from app.config import get_settings
from app.controller.internal.auth import verify_internal_api_key
from app.controller.internal.errors import InternalAPIError
from app.services.workflow.workflow_snapshot_service import WorkflowSnapshotService

router = APIRouter(dependencies=[Depends(verify_internal_api_key)])


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


@router.get("/{flow_task_id}/snapshot")
async def get_workflow_snapshot(flow_task_id: str, request: Request) -> dict[str, Any]:
    snapshot = await WorkflowSnapshotService.get_snapshot(_database(request), flow_task_id)
    if snapshot is None:
        raise InternalAPIError(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="workflow snapshot not found",
        )
    return snapshot
