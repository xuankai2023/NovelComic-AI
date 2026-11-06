"""Flow project 查询。编辑带 user_id，只按 flow_id 的读取只给分享。"""

from copy import deepcopy
from datetime import datetime
from typing import Any

from app.database.mongo import FLOW_PROJECTS


class FlowDao:
    @classmethod
    async def get_workflow_project(
        cls,
        database: Any,
        flow_id: str,
        user_id: str,
    ) -> dict[str, Any] | None:
        return await cls._find_one(database, {"flow_id": flow_id, "user_id": user_id})

    @classmethod
    async def get_workflow_project_by_flow_id(
        cls,
        database: Any,
        flow_id: str,
    ) -> dict[str, Any] | None:
        """分享读取。编辑、创建分享和 run 不要调用这个函数。"""
        return await cls._find_one(database, {"flow_id": flow_id})

    @classmethod
    async def insert_workflow_project(cls, database: Any, project: dict[str, Any]) -> None:
        await database[FLOW_PROJECTS].insert_one(dict(project))

    @classmethod
    async def update_workflow_project(
        cls,
        database: Any,
        *,
        flow_id: str,
        user_id: str,
        updates: dict[str, Any],
    ) -> None:
        await database[FLOW_PROJECTS].update_one(
            {"flow_id": flow_id, "user_id": user_id},
            {"$set": updates},
        )

    @classmethod
    async def update_workflow_project_last_view_time(
        cls,
        database: Any,
        *,
        flow_id: str,
        user_id: str,
        last_view_time: datetime,
    ) -> None:
        await database[FLOW_PROJECTS].update_one(
            {"flow_id": flow_id, "user_id": user_id},
            {"$set": {"last_view_time": last_view_time}},
        )

    @staticmethod
    async def _find_one(database: Any, query: dict[str, Any]) -> dict[str, Any] | None:
        document = await database[FLOW_PROJECTS].find_one(query, {"_id": 0})
        if document is None:
            return None
        return deepcopy(document)
