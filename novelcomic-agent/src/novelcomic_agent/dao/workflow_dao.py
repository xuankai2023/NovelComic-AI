"""Flow reads and writes scoped to the authenticated user."""

from __future__ import annotations

from typing import Any


class WorkflowDAO:
    """Mongo access for a user's workflow project."""

    def __init__(self, flow_col: Any) -> None:
        self._flow_col = flow_col

    async def get_workflow(self, flow_id: str, user_id: str) -> dict[str, Any] | None:
        document = await self._flow_col.find_one(
            {"flow_id": flow_id, "user_id": user_id},
            {"_id": 0},
        )
        if not isinstance(document, dict):
            return None
        return document

    async def update_workflow(
        self,
        flow_id: str,
        user_id: str,
        nodes: list[Any],
        edges: list[Any],
    ) -> None:
        await self._flow_col.update_one(
            {"flow_id": flow_id, "user_id": user_id},
            {"$set": {"nodes": nodes, "edges": edges}},
        )
