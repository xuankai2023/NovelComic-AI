"""Consumer 集合代理和启动索引。

集合名和 Publisher 主库一致。`flow_run_state` 可以读，节点状态迁移由 Consumer 写。
只有四条 v2 索引创建失败会让进程退出，其余失败打 warning 后继续。
"""

from __future__ import annotations

import asyncio
import logging
import sys
from threading import Lock
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient

from app.config import get_settings

logger = logging.getLogger(__name__)

USERS = "users"
FLOW_TASK = "flow_task"
NODE_RESULTS = "node_results"
USAGE_V2 = "usage_v2"
ORDERS = "orders"
SUBSCRIPTION_INFO = "subscription_info"
GIFT_CREDITS = "gift_credits"
SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
CREDITS_INOUT_RECORD = "credits_inout_record"
B2B_SIGNAL_EVENTS = "b2b_signal_events"
B2B_SIGNAL_NOTIFICATIONS = "b2b_signal_notifications"
B2B_SIGNAL_ACTIONS = "b2b_signal_actions"
FLOW_RUN_STATE = "flow_run_state"
FLOW_NODE_STATE = "flow_node_state"
MODEL_INVOCATION = "model_invocation"
FLOW_EVENT_OUTBOX = "flow_event_outbox"
FLOW_COMMAND_INBOX = "flow_command_inbox"
PENDING_MODEL_CALLBACK = "pending_model_callback"

REQUIRED_V2_INDEXES = frozenset(
    {
        "flow_event_outbox_event_id_unique",
        "flow_event_outbox_sent_ttl",
        "flow_command_inbox_command_id_unique",
        "flow_command_inbox_terminal_ttl",
    }
)

_clients: dict[int, Any] = {}
_lock = Lock()


def get_client() -> Any:
    """按当前 event loop 取 Mongo client。没有运行中的 loop 时用线程上的 loop。"""

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()
    loop_id = id(loop)
    with _lock:
        client = _clients.get(loop_id)
        if client is None:
            client = AsyncIOMotorClient(get_settings().mongo_url)
            _clients[loop_id] = client
        return client


def get_db() -> Any:
    """当前 loop 上的主库，库名和 Publisher 相同。"""

    return get_client()[get_settings().mongo_database]


class _CollectionProxy:
    """每次访问都按当前 loop 取集合，不缓存启动时的 db。"""

    def __init__(self, collection_name: str) -> None:
        self._collection_name = collection_name

    def _get_collection(self) -> Any:
        return get_db()[self._collection_name]

    def __getattr__(self, name: str) -> Any:
        return getattr(self._get_collection(), name)

    def __repr__(self) -> str:
        return f"<_CollectionProxy({self._collection_name})>"


user_collection = _CollectionProxy(USERS)
flow_task_collection = _CollectionProxy(FLOW_TASK)
running_result_collection = _CollectionProxy(NODE_RESULTS)
usage_v2_collection = _CollectionProxy(USAGE_V2)
order_collection = _CollectionProxy(ORDERS)
subscription_info_collection = _CollectionProxy(SUBSCRIPTION_INFO)
gift_credits_collection = _CollectionProxy(GIFT_CREDITS)
subscription_user_credits_collection = _CollectionProxy(SUBSCRIPTION_USER_CREDITS)
credits_inout_record_collection = _CollectionProxy(CREDITS_INOUT_RECORD)
b2b_signal_events_collection = _CollectionProxy(B2B_SIGNAL_EVENTS)
b2b_signal_notifications_collection = _CollectionProxy(B2B_SIGNAL_NOTIFICATIONS)
b2b_signal_actions_collection = _CollectionProxy(B2B_SIGNAL_ACTIONS)
flow_run_state_collection = _CollectionProxy(FLOW_RUN_STATE)
flow_node_state_collection = _CollectionProxy(FLOW_NODE_STATE)
model_invocation_collection = _CollectionProxy(MODEL_INVOCATION)
flow_event_outbox_collection = _CollectionProxy(FLOW_EVENT_OUTBOX)
flow_command_inbox_collection = _CollectionProxy(FLOW_COMMAND_INBOX)
pending_model_callback_collection = _CollectionProxy(PENDING_MODEL_CALLBACK)


def _index_specs() -> list[tuple[Any, Any, dict[str, Any]]]:
    return [
        (flow_task_collection, [("flow_task_id", 1)], {"background": True}),
        (flow_run_state_collection, [("run_id", 1)], {"unique": True, "background": True}),
        (
            flow_run_state_collection,
            [("flow_task_id", 1), ("status", 1)],
            {"background": True},
        ),
        (
            flow_run_state_collection,
            [("flow_task_id", 1), ("updated_at", -1)],
            {"background": True},
        ),
        (
            flow_run_state_collection,
            [
                ("protocol_version", 1),
                ("status", 1),
                ("terminal_event_outbox_recorded", 1),
                ("updated_at", 1),
            ],
            {"background": True, "name": "flow_run_v2_terminal_event_reconcile"},
        ),
        (
            flow_run_state_collection,
            [
                ("flow_resume_queue", 1),
                ("status", 1),
                ("protocol_version", 1),
                ("start_initialized", 1),
            ],
            {"background": True, "name": "flow_run_v2_start_recovery"},
        ),
        (
            flow_node_state_collection,
            [("run_id", 1), ("node_id", 1)],
            {"unique": True, "background": True},
        ),
        (
            flow_node_state_collection,
            [("run_id", 1), ("status", 1)],
            {"background": True},
        ),
        (
            model_invocation_collection,
            [("invocation_id", 1)],
            {"unique": True, "background": True},
        ),
        (
            model_invocation_collection,
            [("vendor", 1), ("external_task_id", 1)],
            {
                "unique": True,
                "background": True,
                "partialFilterExpression": {"external_task_id": {"$type": "string"}},
            },
        ),
        (
            model_invocation_collection,
            [("run_id", 1), ("node_id", 1), ("result_id", 1), ("attempt", 1)],
            {"unique": True, "background": True},
        ),
        (
            model_invocation_collection,
            [("run_id", 1), ("node_id", 1), ("status", 1)],
            {"background": True},
        ),
        (
            model_invocation_collection,
            [("status", 1), ("updated_at", 1)],
            {"background": True},
        ),
        (
            model_invocation_collection,
            [("vendor", 1), ("metadata.trace_id", 1), ("metadata.idempotency_key", 1)],
            {
                "background": True,
                "partialFilterExpression": {"metadata.trace_id": {"$type": "string"}},
            },
        ),
        (
            running_result_collection,
            [("run_id", 1), ("result_id", 1)],
            {"unique": True, "background": True},
        ),
        (
            usage_v2_collection,
            [("deduction_id", 1)],
            {
                "unique": True,
                "background": True,
                "partialFilterExpression": {"deduction_id": {"$type": "string"}},
            },
        ),
        (
            pending_model_callback_collection,
            [("vendor", 1), ("external_task_id", 1)],
            {"background": True},
        ),
        (
            flow_event_outbox_collection,
            [("status", 1), ("created_at", 1)],
            {"background": True},
        ),
        (
            flow_event_outbox_collection,
            [("status", 1), ("updated_at", 1)],
            {"background": True},
        ),
        (
            flow_event_outbox_collection,
            [("status", 1), ("publish_lease_expires_at", 1)],
            {"background": True},
        ),
        (
            flow_event_outbox_collection,
            [("status", 1), ("next_attempt_at", 1)],
            {"background": True},
        ),
        (
            flow_event_outbox_collection,
            [("event_id", 1)],
            {"unique": True, "background": True, "name": "flow_event_outbox_event_id_unique"},
        ),
        (
            flow_event_outbox_collection,
            [("expires_at", 1)],
            {
                "background": True,
                "expireAfterSeconds": 0,
                "name": "flow_event_outbox_sent_ttl",
            },
        ),
        (
            flow_event_outbox_collection,
            [("flow_task_id", 1), ("status", 1), ("created_at", -1)],
            {"background": True},
        ),
        (
            flow_command_inbox_collection,
            [("command_id", 1)],
            {"unique": True, "background": True, "name": "flow_command_inbox_command_id_unique"},
        ),
        (
            flow_command_inbox_collection,
            [("flow_task_id", 1), ("created_at", -1)],
            {"background": True},
        ),
        (
            flow_command_inbox_collection,
            [("status", 1), ("lease_expires_at", 1)],
            {"background": True},
        ),
        (
            flow_command_inbox_collection,
            [("status", 1), ("next_attempt_at", 1)],
            {"background": True},
        ),
        (
            flow_command_inbox_collection,
            [("redelivery_lease_expires_at", 1), ("created_at", 1)],
            {"background": True},
        ),
        (
            flow_command_inbox_collection,
            [("expires_at", 1)],
            {
                "background": True,
                "expireAfterSeconds": 0,
                "name": "flow_command_inbox_terminal_ttl",
            },
        ),
        (
            credits_inout_record_collection,
            [("user_id", 1), ("direction", 1), ("created_at", -1)],
            {"background": True, "name": "credits_inout_user_direction_created"},
        ),
        (
            credits_inout_record_collection,
            [("event_type", 1), ("created_at", -1)],
            {"background": True, "name": "credits_inout_event_created"},
        ),
        (
            credits_inout_record_collection,
            "idempotency_key",
            {
                "unique": True,
                "background": True,
                "name": "credits_inout_idempotency_unique",
                "partialFilterExpression": {"idempotency_key": {"$type": "string"}},
            },
        ),
        (
            b2b_signal_events_collection,
            "event_id",
            {"unique": True, "background": True, "name": "b2b_signal_events_event_id_unique"},
        ),
        (
            b2b_signal_events_collection,
            [("user_id", 1), ("event_type", 1), ("created_at", -1)],
            {"background": True, "name": "b2b_signal_events_user_event_created"},
        ),
        (
            b2b_signal_notifications_collection,
            [("user_id", 1), ("composite_signal_key", 1)],
            {
                "unique": True,
                "background": True,
                "name": "b2b_signal_notifications_user_signal_unique",
            },
        ),
        (
            b2b_signal_notifications_collection,
            [("status", 1), ("updated_at", -1)],
            {"background": True, "name": "b2b_signal_notifications_status_updated"},
        ),
        (
            b2b_signal_actions_collection,
            [("user_id", 1), ("action_type", 1), ("status", 1), ("created_at", -1)],
            {
                "background": True,
                "name": "b2b_signal_user_actions_user_action_status_created",
            },
        ),
        (
            b2b_signal_actions_collection,
            [("action_type", 1), ("status", 1), ("eligible_at", 1)],
            {"background": True, "name": "b2b_signal_user_actions_due_conditional"},
        ),
    ]


async def init_consumer_v1_indexes() -> None:
    """逐条建索引。四条 v2 必需索引失败则抛出，其余失败只 warning。"""

    for collection, keys, kwargs in _index_specs():
        try:
            await collection.create_index(keys, **kwargs)
        except Exception as exc:
            index_name = kwargs.get("name")
            if index_name in REQUIRED_V2_INDEXES:
                logger.error(
                    "required workflow v2 index init failed: "
                    "name=%s collection=%s keys=%s err=%s",
                    index_name,
                    collection,
                    keys,
                    exc,
                )
                raise
            logger.warning(
                "consumer v1 index init skipped/failed: collection=%s keys=%s err=%s",
                collection,
                keys,
                exc,
            )


async def test_mongo() -> None:
    """先确认能列出集合，再建索引。连接失败或四条必需索引失败时进程退出。"""

    try:
        await get_db().list_collection_names()
        await init_consumer_v1_indexes()
    except Exception:
        logger.exception("mongodb connection failed")
        sys.exit(1)
    logger.info("mongodb connection ok")
