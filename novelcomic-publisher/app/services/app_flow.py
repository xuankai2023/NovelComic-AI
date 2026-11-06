"""App Flow business logic."""

from datetime import UTC, datetime
from typing import Any

from app.dao.app_flow import AppFlowDao
from app.dao.flow import FlowDao
from app.schemas.app_flow import AppFlow
from app.schemas.request_schemas.app_flow.create_app_flow_request import CreateAppFlowRequest
from app.schemas.request_schemas.app_flow.update_app_flow_request import UpdateAppFlowRequest


class AppFlowAlreadyExistsError(Exception):
    """Raised when an App Flow already exists for a flow."""


class AppFlowNotFoundError(Exception):
    """Raised when an App Flow record cannot be found."""


class AppFlowSourceNotFoundError(Exception):
    """Raised when the source workflow project cannot be found for the user."""


class AppFlowService:
    @classmethod
    async def create_app_flow(
        cls,
        *,
        database: Any,
        req: CreateAppFlowRequest,
        user_id: str,
    ) -> AppFlow:
        if await AppFlowDao.exists_by_flow_id(database, req.flow_id):
            raise AppFlowAlreadyExistsError

        workflow = await cls._get_user_workflow(database, flow_id=req.flow_id, user_id=user_id)
        now = datetime.now(UTC)
        document = {
            "flow_id": req.flow_id,
            "user_id": user_id,
            "nodes": workflow.get("nodes") or [],
            "edges": workflow.get("edges") or [],
            "title": req.title,
            "description": req.description,
            "demo_image_urls": req.demo_image_urls,
            "visible_nodes": req.visible_nodes,
            "app_mode_config": req.app_mode_config,
            "created_at": now,
            "updated_at": now,
        }
        created = await AppFlowDao.create(database, document)
        return AppFlow(**created)

    @classmethod
    async def get_app_flow(
        cls,
        *,
        database: Any,
        flow_id: str,
    ) -> AppFlow | None:
        document = await AppFlowDao.get_by_flow_id(database, flow_id)
        return AppFlow(**document) if document is not None else None

    @classmethod
    async def update_app_flow(
        cls,
        *,
        database: Any,
        flow_id: str,
        req: UpdateAppFlowRequest,
        user_id: str,
    ) -> AppFlow:
        existing = await AppFlowDao.get_by_flow_id(database, flow_id)
        if existing is None:
            raise AppFlowNotFoundError

        update_data: dict[str, Any] = {"updated_at": datetime.now(UTC)}
        if req.sync_workflow:
            workflow = await cls._get_user_workflow(database, flow_id=flow_id, user_id=user_id)
            update_data["nodes"] = workflow.get("nodes") or []
            update_data["edges"] = workflow.get("edges") or []

        explicit_updates = req.model_dump(exclude_unset=True, exclude={"sync_workflow"})
        for key, value in explicit_updates.items():
            update_data[key] = value

        await AppFlowDao.update_by_flow_id(database, flow_id, update_data)
        updated = await AppFlowDao.get_by_flow_id(database, flow_id)
        if updated is None:
            raise AppFlowNotFoundError
        return AppFlow(**updated)

    @staticmethod
    async def _get_user_workflow(database: Any, *, flow_id: str, user_id: str) -> dict[str, Any]:
        workflow = await FlowDao.get_workflow_project(database, flow_id, user_id)
        if workflow is None:
            raise AppFlowSourceNotFoundError
        return workflow
