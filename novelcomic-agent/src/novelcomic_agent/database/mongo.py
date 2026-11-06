"""Agent 集合句柄和启动索引。

先绑自己的集合，再绑共享集合。`_safe_create_index()` 只吞
`OperationFailure` 85 和 86。其他错误继续抛，启动失败。

`agent_tool_traces` 的 TTL 挂在 `completed_at` 上，保留 30 天。
不要写成 `workflow_command` 那种 `expires_at`。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from pymongo.errors import OperationFailure

logger = logging.getLogger(__name__)

AGENT_SESSIONS = "agent_sessions"
AGENT_MESSAGES = "agent_messages"
AGENT_CHAT_MESSAGES = "agent_chat_messages"
AGENT_EVENTS = "agent_events"
AGENT_TOOL_TRACES = "agent_tool_traces"
AGENT_MESSAGE_FEEDBACK = "agent_message_feedback"
MEMORIES = "memories"

# Publisher 把项目详情写在 flow_projects，不另开 flow_details。
FLOW_DETAILS = "flow_projects"
FLOW_VERSION = "flow_version"
FLOW_TASK = "flow_task"
# 执行结果写在 node_results。
RESULTS = "node_results"
SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
GIFT_CREDITS = "gift_credits"
CUT_PROJECT = "cut_project"
CUT_RENDER_TASKS = "cut_render_tasks"

TOOL_TRACE_TTL_SECONDS = 2_592_000
_SHARED_INDEX_CONFLICTS = (85, 86)


@dataclass(frozen=True)
class AgentCollections:
    """自己的集合在前，共享集合在后。"""

    agent_sessions: Any
    agent_messages: Any
    agent_chat_messages: Any
    agent_events: Any
    agent_tool_traces: Any
    agent_message_feedback: Any
    memories: Any
    flow_details: Any
    flow_version: Any
    flow_task: Any
    results: Any
    subscription_user_credits: Any
    gift_credits: Any
    cut_project: Any
    cut_render_tasks: Any


def bind_collections(database: Any) -> AgentCollections:
    """先绑自己的集合，再绑共享集合。"""

    return AgentCollections(
        agent_sessions=database[AGENT_SESSIONS],
        agent_messages=database[AGENT_MESSAGES],
        agent_chat_messages=database[AGENT_CHAT_MESSAGES],
        agent_events=database[AGENT_EVENTS],
        agent_tool_traces=database[AGENT_TOOL_TRACES],
        agent_message_feedback=database[AGENT_MESSAGE_FEEDBACK],
        memories=database[MEMORIES],
        flow_details=database[FLOW_DETAILS],
        flow_version=database[FLOW_VERSION],
        flow_task=database[FLOW_TASK],
        results=database[RESULTS],
        subscription_user_credits=database[SUBSCRIPTION_USER_CREDITS],
        gift_credits=database[GIFT_CREDITS],
        cut_project=database[CUT_PROJECT],
        cut_render_tasks=database[CUT_RENDER_TASKS],
    )


async def _safe_create_index(collection: Any, keys: Any, **kwargs: Any) -> None:
    """只吞 OperationFailure 85 和 86。其他错误继续抛。"""

    try:
        await collection.create_index(keys, **kwargs)
    except OperationFailure as exc:
        if exc.code in _SHARED_INDEX_CONFLICTS:
            logger.warning(
                "index already exists on shared collection: collection=%s name=%s code=%s msg=%s",
                getattr(collection, "name", "?"),
                kwargs.get("name", "?"),
                exc.code,
                str(exc)[:200],
            )
            return
        raise


async def ensure_indexes(database: Any) -> None:
    """创建 Agent 索引。规格不变时可以重复调用。"""

    collections = bind_collections(database)

    await _safe_create_index(
        collections.agent_sessions,
        [("user_id", 1), ("updated_at", -1)],
        name="user_updated_idx",
    )
    await _safe_create_index(
        collections.agent_sessions,
        [("user_id", 1), ("workflow_id", 1)],
        name="user_workflow_idx",
        partialFilterExpression={"workflow_id": {"$exists": True}},
    )

    await _safe_create_index(
        collections.agent_messages,
        [("session_id", 1), ("seq", -1)],
        name="session_seq_idx",
    )
    await _safe_create_index(
        collections.agent_messages,
        [("session_id", 1), ("role", 1), ("turn", -1)],
        name="session_role_turn_idx",
    )
    await _safe_create_index(
        collections.agent_messages,
        [("session_id", 1), ("turn", 1), ("seq", 1)],
        name="session_turn_seq_idx",
    )

    await _safe_create_index(
        collections.agent_chat_messages,
        [("session_id", 1), ("seq_start", -1)],
        name="session_chat_seq_idx",
    )
    await _safe_create_index(
        collections.agent_chat_messages,
        [("session_id", 1), ("message_id", 1)],
        name="session_message_unique_idx",
        unique=True,
    )
    await _safe_create_index(
        collections.agent_chat_messages,
        [("session_id", 1), ("seq_end", -1)],
        name="session_seq_end_idx",
    )

    await _safe_create_index(
        collections.agent_events,
        [("session_id", 1), ("seq", 1)],
        name="session_event_seq_idx",
    )
    await _safe_create_index(
        collections.agent_events,
        [("session_id", 1), ("event_id", 1)],
        name="session_event_unique_idx",
        unique=True,
    )

    await _safe_create_index(
        collections.agent_tool_traces,
        [("session_id", 1), ("started_at", -1)],
        name="session_started_idx",
    )
    await _safe_create_index(
        collections.agent_tool_traces,
        [("tool_name", 1), ("status", 1), ("duration_ms", -1)],
        name="tool_perf_idx",
    )
    await _safe_create_index(
        collections.agent_tool_traces,
        [("completed_at", 1)],
        name="ttl_cleanup_idx",
        expireAfterSeconds=TOOL_TRACE_TTL_SECONDS,
    )

    await _safe_create_index(
        collections.agent_message_feedback,
        [("session_id", 1), ("turn", 1), ("user_id", 1)],
        name="session_turn_user_unique_idx",
        unique=True,
    )
    await _safe_create_index(
        collections.agent_message_feedback,
        [("session_id", 1)],
        name="session_idx",
    )

    await _safe_create_index(
        collections.memories,
        [("payload.user_id", 1)],
        name="payload_user_idx",
    )

    await _safe_create_index(
        collections.flow_details,
        [("flow_id", 1)],
        name="flow_id_idx",
    )
    await _safe_create_index(
        collections.flow_version,
        [("flow_id", 1), ("created_at", -1)],
        name="flow_created_idx",
    )
    await _safe_create_index(
        collections.flow_task,
        [("flow_task_id", 1), ("user_id", 1)],
        name="flow_task_user_idx",
    )
    await _safe_create_index(
        collections.results,
        [("workflow_id", 1), ("user_id", 1), ("node_id", 1), ("created_at", -1)],
        name="workflow_user_node_created_idx",
    )

    await _safe_create_index(
        collections.subscription_user_credits,
        [("user_id", 1), ("status", 1), ("end_timestamp", 1)],
        name="user_status_end_idx",
    )
    await _safe_create_index(
        collections.gift_credits,
        [("user_id", 1), ("expire_timestamp", 1)],
        name="user_expire_idx",
    )

    await _safe_create_index(
        collections.cut_project,
        [("user_id", 1), ("created_at", -1)],
        name="user_created_idx",
    )
    await _safe_create_index(
        collections.cut_project,
        [("session_id", 1)],
        name="session_idx",
    )
    await _safe_create_index(
        collections.cut_project,
        [("cut_project_id", 1), ("user_id", 1), ("status", 1)],
        name="project_user_status_idx",
    )
    await _safe_create_index(
        collections.cut_render_tasks,
        [("user_id", 1), ("created_at", -1)],
        name="user_created_idx",
    )
    await _safe_create_index(
        collections.cut_render_tasks,
        [("cut_project_id", 1)],
        name="project_idx",
    )
    await _safe_create_index(
        collections.cut_render_tasks,
        [("render_task_id", 1), ("user_id", 1)],
        name="render_task_user_idx",
    )
