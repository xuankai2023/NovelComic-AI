"""Agent session storage contracts.

This module defines the MongoDB document shapes for agent conversations. Business
logic belongs in ``novelcomic_agent.session.manager``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class RawMessageDoc(BaseModel):
    """Append-only raw message stored in ``agent_messages``."""

    model_config = ConfigDict(extra="forbid")

    role: Literal[
        "system",
        "user",
        "assistant",
        "tool",
        "workflow_event",
        "tool_call",
        "tool_event",
        "tool_result",
    ]
    content: str | list[dict[str, Any]] | None = None
    turn: int | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call: dict[str, Any] | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    name: str | None = None
    tool_hints: list[str] | None = None
    thinking_blocks: list[dict[str, Any]] | None = None
    reasoning_content: str | None = None
    provider_content_blocks: list[dict[str, Any]] | None = None
    metadata: dict[str, Any] | None = None
    event: str | None = None
    event_data: dict[str, Any] | None = None
    status: str | None = None
    error: str | None = None
    duration_ms: int | None = None
    thinking_duration_ms: int | None = None
    output_size_bytes: int | None = None
    truncated: bool | None = None
    is_ephemeral: bool | None = None
    created_at: str | None = None


class AgentRuntimeEventDoc(BaseModel):
    """Auditable runtime event stored in ``agent_events``."""

    model_config = ConfigDict(extra="forbid")

    event_id: str
    session_id: str
    turn_id: str
    run_id: str | None = None
    seq: int
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None


class AgentToolTraceDoc(BaseModel):
    """Tool execution trace stored in ``agent_tool_traces``."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    turn: int
    tool_call_id: str
    tool_name: str
    input: dict[str, Any] = Field(default_factory=dict)
    output: str = ""
    output_size_bytes: int = 0
    status: Literal["success", "error"] = "success"
    error: str | None = None
    duration_ms: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ChatProjectionPartDoc(BaseModel):
    """Frontend-renderable part in an ``agent_chat_messages`` document."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[
        "text",
        "agent_progress",
        "tool_step",
        "hitl",
        "runtime_status",
        "workflow_select",
        "workflow_node_result",
        "workflow_node_error",
        "subagent_step",
        "generation_confirm",
    ]
    text: str | None = None
    part_id: str | None = None
    confirm_id: str | None = None
    media: str | None = None
    groups: list[dict[str, Any]] | None = None
    multi_atom_notice: bool | None = None
    tool_name: str | None = None
    title: str | None = None
    summary: str | None = None
    hitl_id: str | None = None
    hitl_type: Literal["select", "ask"] | None = None
    kind: Literal["pipeline", "workflow_node", "thinking", "billing", "cut"] | None = None
    status: str | None = None
    current_stage: str | None = None
    stages: list[dict[str, Any]] | None = None
    data: dict[str, Any] | None = None
    node_id: str | None = None
    run_id: str | None = None
    flow_task_id: str | None = None
    node_type: str | None = None
    selection_mode: Literal["single", "multi"] | None = None
    hint: str | None = None
    recommended_action: str | None = None
    outputs: list[dict[str, Any]] | None = None
    selected_indices: list[int] | None = None
    error_msg: str | None = None
    error_code: int | None = None
    gateway_error: dict[str, Any] | None = None
    error_display_group: str | None = None
    error_action: str | None = None
    error_params: dict[str, Any] | None = None
    provider_message: str | None = None
    failure_analysis: dict[str, Any] | None = None
    index: int | None = None
    agent_type: str | None = None
    task: str | None = None
    tool_steps: list[dict[str, Any]] | None = None
    text_content: str | None = None
    result_preview: str | None = None


class ChatProjectionMessageDoc(BaseModel):
    """Frontend chat history projection stored in ``agent_chat_messages``."""

    model_config = ConfigDict(extra="forbid")

    message_id: str
    session_id: str
    turn_id: str
    role: Literal["user", "assistant", "system"]
    status: Literal["streaming", "complete", "failed", "waiting_hitl", "cancelled"] = "complete"
    parts: list[ChatProjectionPartDoc] = Field(default_factory=list)
    metadata: dict[str, Any] | None = None
    seq_start: int = 0
    seq_end: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class AgentSessionDoc(BaseModel):
    """Session metadata stored in ``agent_sessions``."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    user_id: str = ""
    workflow_id: str | None = None
    channel: str = "api"
    summary: str | None = None
    message_count: int = 0
    turn_count: int = 0
    status: str = "idle"
    revision: int = 0
    last_seq: int = 0
    last_message_preview: str | None = None
    current_hitl: dict[str, Any] | None = None
    pipeline_state: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentMessageFeedbackDoc(BaseModel):
    """User feedback for a projected chat message."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    turn: int
    user_id: str
    rating: Literal["like", "dislike"]
    comment: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
