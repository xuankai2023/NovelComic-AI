"""Run the workflow that belongs to the authenticated canvas user."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from novelcomic_agent.core.tools.base import Tool
from novelcomic_agent.workflow.task_publisher import run_flow


class RunWorkflowTool(Tool):
    """Refuse to query a flow until both user_id and flow_id are present."""

    def __init__(self, workflow_dao: Any | None = None, context: Any | None = None) -> None:
        self._workflow_dao = workflow_dao
        self._context = context

    @property
    def name(self) -> str:
        return "run_workflow"

    @property
    def description(self) -> str:
        return "Run the current workflow for the authenticated user."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "start_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional start node IDs to run from.",
                },
                "end_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional end node IDs to stop at.",
                },
                "task_id": {
                    "type": "string",
                    "description": "Optional flow_task_id override.",
                },
                "run_id": {
                    "type": "string",
                    "description": "Optional flow_run_id override.",
                },
                "command_id": {
                    "type": "string",
                    "description": "Optional idempotent command_id.",
                },
            },
        }

    async def execute(
        self,
        arguments: Mapping[str, Any] | None = None,
        context: Any | None = None,
        **kwargs: Any,
    ) -> str:
        resolved_args: dict[str, Any] = {}
        if isinstance(arguments, Mapping):
            resolved_args.update(arguments)
        resolved_args.update(kwargs)
        resolved_context = context if context is not None else self._context

        flow_id = _context_text(resolved_context, "flow_id") or str(resolved_args.get("flow_id") or "").strip()
        user_id = _context_text(resolved_context, "user_id") or str(resolved_args.get("user_id") or "").strip()
        if not flow_id:
            return "Error: no flow_id in context. This tool requires an active canvas session."
        if not user_id:
            return "Error: no authenticated user in context."

        dao = self._workflow_dao
        if dao is None and resolved_context is not None:
            dao = getattr(resolved_context, "workflow_dao", None)
        if dao is None and isinstance(resolved_context, Mapping):
            dao = resolved_context.get("workflow_dao")
        if dao is None:
            return "Error: workflow data access is not configured."

        workflow = await dao.get_workflow(flow_id, user_id)
        if not workflow:
            return "Error: workflow was not found."

        redis_client = _context_value(resolved_context, "redis_client")
        if redis_client is None and isinstance(resolved_context, Mapping):
            redis_client = resolved_context.get("redis")
        if redis_client is None:
            # Keep the tool useful in read-only/test contexts while making the
            # absence of a transport explicit instead of claiming execution.
            return f"Workflow {flow_id} is ready."

        payload = dict(resolved_args)
        payload.setdefault("flow_id", flow_id)
        payload.setdefault("user_id", user_id)
        payload.setdefault("flow_task_id", payload.get("task_id") or flow_id)
        payload.setdefault("flow_run_id", payload.get("run_id") or "")
        payload.setdefault(
            "dag",
            workflow.get("dag")
            or {
                "nodes": workflow.get("nodes", []),
                "edges": workflow.get("edges", []),
            },
        )
        payload.setdefault("start_ids", workflow.get("start_ids") or [])
        payload.setdefault("end_ids", workflow.get("end_ids") or [])
        payload.setdefault("command_id", payload.get("command_id") or f"agent-run-{flow_id}")
        message_id = await run_flow.publish(
            payload,
            redis_client=redis_client,
            task_id=payload["flow_task_id"],
        )
        return f"Workflow {flow_id} submitted (message_id={message_id})."


def _context_text(context: Any, key: str) -> str:
    if context is None:
        return ""
    if isinstance(context, Mapping):
        value = context.get(key)
    else:
        value = getattr(context, key, None)
    if not isinstance(value, str):
        return ""
    return value.strip()


def _context_value(context: Any, key: str) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return context.get(key)
    value = getattr(context, key, None)
    if value is not None:
        return value
    extra = getattr(context, "extra", None)
    return extra.get(key) if isinstance(extra, Mapping) else None
