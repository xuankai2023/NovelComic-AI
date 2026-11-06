"""Create and visit immutable flow shares."""

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.common.exception.exception_share import (
    ShareEmailNotAllowedError,
    ShareNotFoundError,
    ShareSourceNotFoundError,
)
from app.dao.flow import FlowDao
from app.dao.share import ShareDao
from app.schemas.request_schemas.share.create_share_request import CreateShareRequest
from app.schemas.share import DataBaseCreateFlowTask


class ShareService:
    @staticmethod
    def generate_share_id() -> str:
        return uuid4().hex

    @classmethod
    async def create_share_flow_v3(
        cls,
        *,
        database: Any,
        req: CreateShareRequest,
        user_id: str,
        user_email: str | None,
    ) -> dict[str, Any]:
        project = await FlowDao.get_workflow_project(database, req.flow_id, user_id)
        if project is None:
            raise ShareSourceNotFoundError("Flow project not found")

        email_whitelist = list(req.email_whitelist)
        normalized_user_email = (user_email or "").strip().lower()
        if (
            email_whitelist
            and normalized_user_email
            and normalized_user_email not in email_whitelist
        ):
            email_whitelist.append(normalized_user_email)

        now = datetime.now(UTC)
        snapshot = cls._build_snapshot(project)
        document = {
            "share_id": cls.generate_share_id(),
            "flow_id": req.flow_id,
            "owner_user_id": user_id,
            "owner_email": normalized_user_email or None,
            "email_whitelist": email_whitelist,
            "allow_reshare": req.allow_reshare,
            "share_type": req.share_type,
            "snapshot": snapshot.model_dump(mode="python"),
            "created_at": now,
            "updated_at": now,
        }
        return await ShareDao.create(database, document)

    @classmethod
    async def get_share_info(cls, *, database: Any, share_id: str) -> dict[str, Any]:
        share = await cls._get_existing_share(database, share_id)
        if cls._need_auth(share):
            share = dict(share)
            share["snapshot"] = None
        return share

    @classmethod
    async def visit_share(
        cls,
        *,
        database: Any,
        share_id: str,
        user_email: str | None,
    ) -> dict[str, Any]:
        share = await cls._get_existing_share(database, share_id)
        whitelist = share.get("email_whitelist") or []
        if whitelist:
            normalized_email = (user_email or "").strip().lower()
            if normalized_email not in whitelist:
                raise ShareEmailNotAllowedError("Email is not allowed to visit this share")
        return share

    @classmethod
    async def _get_existing_share(cls, database: Any, share_id: str) -> dict[str, Any]:
        share = await ShareDao.get_by_share_id(database, share_id)
        if share is None:
            raise ShareNotFoundError("Share not found")
        return share

    @staticmethod
    def _need_auth(share: dict[str, Any]) -> bool:
        return bool(share.get("email_whitelist") or [])

    @staticmethod
    def _build_snapshot(project: dict[str, Any]) -> DataBaseCreateFlowTask:
        details = deepcopy(project.get("details") or {})
        project_name = details.get("project_name") or "Untitled"
        return DataBaseCreateFlowTask(
            flow_id=project["flow_id"],
            project_name=project_name,
            nodes=deepcopy(project.get("nodes") or []),
            edges=deepcopy(project.get("edges") or []),
            details=details,
            allow_reshare=bool(project.get("allow_reshare", True)),
            parent_flow_id=project.get("parent_flow_id"),
        )
