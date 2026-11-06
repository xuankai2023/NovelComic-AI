"""SSE event definitions for the agent chat protocol.

All event producers should return :class:`AgentEvent`; the SSE layer is
responsible only for formatting ``id/event/data`` frames.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4


@dataclass(slots=True)
class AgentEvent:
    """Small event envelope shared by Agent loop, run store, and SSE handlers."""

    event: str
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.event in {RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED}

    def to_dict(self) -> dict[str, Any]:
        return {"event": self.event, "data": self.data}


AGENT_STARTED = "agent.started"
AGENT_COMPLETED = "agent.completed"
AGENT_FAILED = "agent.failed"
AGENT_STOPPED = "agent.stopped"
AGENT_HEARTBEAT = "agent.heartbeat"

THINKING_DELTA = "thinking.delta"
LLM_RESPONSE_COMPLETED = "llm.response.completed"

CHAT_MESSAGE_CREATED = "chat.message.created"
CHAT_MESSAGE_DELTA = "chat.message.delta"
CHAT_PART_UPSERT = "chat.part.upsert"
CHAT_MESSAGE_COMPLETED = "chat.message.completed"
SESSION_STATE_UPDATED = "session.state.updated"

RUN_COMPLETED = "run.completed"
RUN_FAILED = "run.failed"
RUN_CANCELLED = "run.cancelled"

TOOL_STARTED = "tool.started"
TOOL_COMPLETED = "tool.completed"
TOOL_FAILED = "tool.failed"
TOOL_EVENT = "tool.event"

WORKFLOW_STARTED = "workflow.started"
WORKFLOW_NODE_STATUS = "workflow.node_status"
WORKFLOW_MODEL_READY = "workflow.model_ready"
WORKFLOW_MODEL_STATUS = "workflow.model_status"
WORKFLOW_PAUSED = "workflow.paused"
WORKFLOW_COMPLETED = "workflow.completed"
WORKFLOW_NODE_FAILED = "workflow.node_failed"
WORKFLOW_FAILED = "workflow.failed"
WORKFLOW_KILLED = "workflow.killed"
WORKFLOW_SELECT_CARD = "workflow.select_card"
WORKFLOW_SELECTION_RESOLVED = "workflow.selection_resolved"
WORKFLOW_LLM_BATCH_STARTED = "workflow.llm_batch_started"
WORKFLOW_LLM_BATCH_COMPLETED = "workflow.llm_batch_completed"
WORKFLOW_UGC_SCRIPT_READY = "workflow.ugc_script_ready"


def agent_started(session_id: str, run_id: str | None = None) -> AgentEvent:
    return AgentEvent(
        event=AGENT_STARTED,
        data={"session_id": session_id, "run_id": run_id or f"run_{uuid4().hex[:16]}"},
    )


def agent_completed(content: str, usage: dict[str, int] | None = None) -> AgentEvent:
    data: dict[str, Any] = {"content": content}
    if usage is not None:
        data["usage"] = usage
    return AgentEvent(event=AGENT_COMPLETED, data=data)


def agent_failed(
    error: str,
    *,
    code: str | None = None,
    category: str | None = None,
    details: dict[str, Any] | None = None,
) -> AgentEvent:
    data = _without_none(
        {
            "error": error,
            "code": code,
            "category": category,
            "details": details,
        }
    )
    return AgentEvent(event=AGENT_FAILED, data=data)


def agent_stopped(reason: str | None = None) -> AgentEvent:
    return AgentEvent(event=AGENT_STOPPED, data=_without_none({"reason": reason}))


def agent_heartbeat() -> AgentEvent:
    return AgentEvent(event=AGENT_HEARTBEAT, data={})


def thinking_delta(content: str) -> AgentEvent:
    return AgentEvent(event=THINKING_DELTA, data={"content": content})


def llm_response_completed(
    *,
    iteration: int,
    content: str,
    tool_names: list[str],
    finish_reason: str,
) -> AgentEvent:
    return AgentEvent(
        event=LLM_RESPONSE_COMPLETED,
        data={
            "iteration": iteration,
            "content": content,
            "tool_names": tool_names,
            "finish_reason": finish_reason,
        },
    )


def chat_message_created(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    message: dict[str, Any],
) -> AgentEvent:
    return AgentEvent(
        event=CHAT_MESSAGE_CREATED,
        data={
            "session_id": session_id,
            "turn_id": turn_id,
            "run_id": run_id,
            "revision": revision,
            "seq": seq,
            "message": message,
        },
    )


def chat_message_delta(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    message_id: str,
    part_id: str,
    text: str,
) -> AgentEvent:
    return AgentEvent(
        event=CHAT_MESSAGE_DELTA,
        data={
            "session_id": session_id,
            "turn_id": turn_id,
            "run_id": run_id,
            "revision": revision,
            "seq": seq,
            "message_id": message_id,
            "part_id": part_id,
            "text": text,
        },
    )


def chat_part_upsert(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    message_id: str,
    part: dict[str, Any],
) -> AgentEvent:
    return AgentEvent(
        event=CHAT_PART_UPSERT,
        data={
            "session_id": session_id,
            "turn_id": turn_id,
            "run_id": run_id,
            "revision": revision,
            "seq": seq,
            "message_id": message_id,
            "part": part,
        },
    )


def chat_message_completed(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    message_id: str,
    status: str = "complete",
    parts: list[dict[str, Any]] | None = None,
) -> AgentEvent:
    data: dict[str, Any] = {
        "session_id": session_id,
        "turn_id": turn_id,
        "run_id": run_id,
        "revision": revision,
        "seq": seq,
        "message_id": message_id,
        "status": status,
    }
    if parts is not None:
        data["parts"] = parts
    return AgentEvent(event=CHAT_MESSAGE_COMPLETED, data=data)


def session_state_updated(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    state: dict[str, Any],
) -> AgentEvent:
    return AgentEvent(
        event=SESSION_STATE_UPDATED,
        data={
            "session_id": session_id,
            "turn_id": turn_id,
            "run_id": run_id,
            "revision": revision,
            "seq": seq,
            "state": state,
        },
    )


def run_completed(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
) -> AgentEvent:
    return AgentEvent(
        event=RUN_COMPLETED,
        data=_run_data(session_id, turn_id, run_id, revision, seq),
    )


def run_failed(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    error: str,
    code: str | None = None,
    category: str | None = None,
    details: dict[str, Any] | None = None,
) -> AgentEvent:
    data = {
        **_run_data(session_id, turn_id, run_id, revision, seq),
        **_without_none(
            {
                "error": error,
                "code": code,
                "category": category,
                "details": details,
            }
        ),
    }
    return AgentEvent(event=RUN_FAILED, data=data)


def run_cancelled(
    *,
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
    reason: str | None = None,
) -> AgentEvent:
    data = {
        **_run_data(session_id, turn_id, run_id, revision, seq),
        **_without_none({"reason": reason}),
    }
    return AgentEvent(event=RUN_CANCELLED, data=data)


def tool_started(
    tool_name: str,
    tool_call_id: str,
    arguments: dict[str, Any] | None = None,
) -> AgentEvent:
    return AgentEvent(
        event=TOOL_STARTED,
        data={
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "arguments": arguments or {},
        },
    )


def tool_completed(
    tool_call_id: str,
    duration_ms: int,
    *,
    output_preview: str | None = None,
) -> AgentEvent:
    return AgentEvent(
        event=TOOL_COMPLETED,
        data=_without_none(
            {
                "tool_call_id": tool_call_id,
                "duration_ms": duration_ms,
                "output_preview": output_preview,
            }
        ),
    )


def tool_failed(tool_call_id: str, error: str, code: str | None = None) -> AgentEvent:
    return AgentEvent(
        event=TOOL_FAILED,
        data=_without_none({"tool_call_id": tool_call_id, "error": error, "code": code}),
    )


def tool_event(event_name: str, data: dict[str, Any] | None = None) -> AgentEvent:
    return AgentEvent(
        event=TOOL_EVENT,
        data={"event_name": event_name, **(data or {})},
    )


def workflow_started(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_STARTED, data=data)


def workflow_node_status(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_NODE_STATUS, data=data)


def workflow_model_ready(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_MODEL_READY, data=data)


def workflow_model_status(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_MODEL_STATUS, data=data)


def workflow_paused(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_PAUSED, data=data)


def workflow_completed(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_COMPLETED, data=data)


def workflow_node_failed(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_NODE_FAILED, data=data)


def workflow_failed(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_FAILED, data=data)


def workflow_killed(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_KILLED, data=data)


def workflow_select_card(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_SELECT_CARD, data=data)


def workflow_selection_resolved(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_SELECTION_RESOLVED, data=data)


def workflow_llm_batch_started(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_LLM_BATCH_STARTED, data=data)


def workflow_llm_batch_completed(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_LLM_BATCH_COMPLETED, data=data)


def workflow_ugc_script_ready(data: dict[str, Any]) -> AgentEvent:
    return AgentEvent(event=WORKFLOW_UGC_SCRIPT_READY, data=data)


WORKFLOW_EVENT_MAP: dict[str, Any] = {
    "node_status": workflow_node_status,
    "llm_model_ready": workflow_model_ready,
    "llm_model_status": workflow_model_status,
    "finish_flow": workflow_completed,
    "flow_killed": workflow_killed,
    "node_time_out": workflow_failed,
    "start_running_llm_models": workflow_llm_batch_started,
    "finish_running_llm_models": workflow_llm_batch_completed,
}


def _run_data(
    session_id: str,
    turn_id: str,
    run_id: str,
    revision: int,
    seq: int,
) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "turn_id": turn_id,
        "run_id": run_id,
        "revision": revision,
        "seq": seq,
    }


def _without_none(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None}
