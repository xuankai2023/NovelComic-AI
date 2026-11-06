"""Publisher 集合句柄和启动索引。

共享库上的句柄不等于所有权。运行态迁移不在 Publisher：
`flow_run_state`、`flow_node_state` 可以读，节点从 idle 走到 running / select / success
仍由 Consumer 写。`usage_v2` 的确认写入也在 Consumer。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

USERS = "users"
FLOW_PROJECTS = "flow_projects"
FLOW_TASK = "flow_task"
# 共享库句柄。运行态迁移不在 Publisher。
FLOW_RUN_STATE = "flow_run_state"
FLOW_NODE_STATE = "flow_node_state"
WORKFLOW_COMMAND = "workflow_command"
NODE_RESULTS = "node_results"
# 共享库句柄。用量确认写入不在 Publisher。
USAGE_V2 = "usage_v2"
ASSET_LIBRARY_ITEMS = "asset_library_items"
AGENT_SKILLS = "agent_skills"
ORDERS = "orders"
WEBHOOK_EVENTS = "webhook_events"
GIFT_CREDITS = "gift_credits"
SUBSCRIPTION_INFO = "subscription_info"
SUBSCRIPTION_USER_CREDITS = "subscription_user_credits"
SUBSCRIPTION_CHECKOUT_INTENT = "subscription_checkout_intent"
CREDITS_INOUT_RECORD = "credits_inout_record"
CREDITS_TOPUP_RECORD = "credits_topup_record"
DEVELOPER_API_CLIENT = "developer_api_client"
DEVELOPER_WORKFLOW_RUN = "developer_workflow_run"
DEVELOPER_IDEMPOTENCY = "developer_idempotency"
DEVELOPER_EVENT_DLQ = "developer_event_dlq"
INVITE_RELATIONS = "invite_relations"
INVITE_CREDIT_RECORDS = "invite_credit_records"
B2B_SIGNAL_EVENTS = "b2b_signal_events"
B2B_SIGNAL_NOTIFICATIONS = "b2b_signal_notifications"
B2B_SIGNAL_ACTIONS = "b2b_signal_actions"
MEDIA_FACE_VERIFICATIONS = "media_face_verifications"
USER_PREFERENCES = "user_preferences"
AGENT_CATALOG = "agent_catalog"

_CHECKOUT_TERMINAL_STATES = ("completed", "expired", "failed")


@dataclass(frozen=True)
class PublisherCollections:
    """Publisher 拥有这些集合的入口事实。"""

    user: Any
    flow: Any
    flow_task: Any
    flow_run_state: Any
    flow_node_state: Any
    workflow_command: Any
    results: Any
    usage_v2: Any
    asset_library_items: Any
    agent_skills: Any
    orders: Any
    webhook_events: Any
    gift_credits: Any
    subscription_info: Any
    subscription_user_credits: Any
    subscription_checkout_intent: Any
    credits_inout_record: Any
    credits_topup_record: Any
    developer_api_client: Any
    developer_workflow_run: Any
    developer_idempotency: Any
    developer_event_dlq: Any
    invite_relations: Any
    invite_credit_records: Any
    b2b_signal_events: Any
    b2b_signal_notifications: Any
    b2b_signal_actions: Any
    media_face_verifications: Any
    user_preferences: Any
    agent_catalog: Any


def owner_collections(database: Any) -> PublisherCollections:
    """一次列出 Publisher 的 Owner 句柄。

    `flow_run_state` 和 `flow_node_state` 只是共享库句柄，迁移不在 Publisher。
    项目详情写在 `flow_projects` 上，不另开 `flow_details`。
    支付事实写在 `orders`。邀请码写在用户文档上，关系写在 `invite_relations`。
    """

    return PublisherCollections(
        user=database[USERS],
        flow=database[FLOW_PROJECTS],
        flow_task=database[FLOW_TASK],
        flow_run_state=database[FLOW_RUN_STATE],
        flow_node_state=database[FLOW_NODE_STATE],
        workflow_command=database[WORKFLOW_COMMAND],
        results=database[NODE_RESULTS],
        usage_v2=database[USAGE_V2],
        asset_library_items=database[ASSET_LIBRARY_ITEMS],
        agent_skills=database[AGENT_SKILLS],
        orders=database[ORDERS],
        webhook_events=database[WEBHOOK_EVENTS],
        gift_credits=database[GIFT_CREDITS],
        subscription_info=database[SUBSCRIPTION_INFO],
        subscription_user_credits=database[SUBSCRIPTION_USER_CREDITS],
        subscription_checkout_intent=database[SUBSCRIPTION_CHECKOUT_INTENT],
        credits_inout_record=database[CREDITS_INOUT_RECORD],
        credits_topup_record=database[CREDITS_TOPUP_RECORD],
        developer_api_client=database[DEVELOPER_API_CLIENT],
        developer_workflow_run=database[DEVELOPER_WORKFLOW_RUN],
        developer_idempotency=database[DEVELOPER_IDEMPOTENCY],
        developer_event_dlq=database[DEVELOPER_EVENT_DLQ],
        invite_relations=database[INVITE_RELATIONS],
        invite_credit_records=database[INVITE_CREDIT_RECORDS],
        b2b_signal_events=database[B2B_SIGNAL_EVENTS],
        b2b_signal_notifications=database[B2B_SIGNAL_NOTIFICATIONS],
        b2b_signal_actions=database[B2B_SIGNAL_ACTIONS],
        media_face_verifications=database[MEDIA_FACE_VERIFICATIONS],
        user_preferences=database[USER_PREFERENCES],
        agent_catalog=database[AGENT_CATALOG],
    )


@asynccontextmanager
async def mongo_transaction(database: Any):
    """有 Mongo client 时开事务。没有 session 的替身库由调用方自己回滚。"""

    client = getattr(database, "client", None)
    start_session = getattr(client, "start_session", None) if client is not None else None
    if start_session is None:
        yield None
        return
    async with await start_session() as session:
        async with session.start_transaction():
            yield session


async def test_mongo(database: Any) -> None:
    try:
        await database.list_collection_names()
    except Exception as exc:
        logger.exception("mongodb connection failed")
        raise RuntimeError("mongodb connection failed") from exc
    logger.info("mongodb connection ok")


async def ensure_developer_indexes(database: Any) -> None:
    """Developer API 集合索引，重复调用得到同一套键。"""

    collections = owner_collections(database)
    try:
        await collections.developer_api_client.drop_index(
            "developer_api_client_api_key_hash_status"
        )
    except Exception:
        pass

    await collections.developer_api_client.create_index(
        "api_key_hash",
        unique=True,
        name="developer_api_client_api_key_hash_unique",
    )
    await collections.developer_api_client.create_index(
        "client_id",
        unique=True,
        name="developer_api_client_client_id_unique",
    )
    await collections.developer_workflow_run.create_index(
        "task_id",
        unique=True,
        name="developer_workflow_run_task_id_unique",
    )
    await collections.developer_workflow_run.create_index(
        "channel_id",
        name="developer_workflow_run_channel_id",
    )
    await collections.developer_workflow_run.create_index(
        [("api_client_id", 1), ("status", 1), ("updated_at", -1)],
        name="developer_workflow_run_client_status_updated",
    )
    await collections.developer_workflow_run.create_index(
        [("owner_user_id", 1), ("created_at", -1)],
        name="developer_workflow_run_owner_created",
    )
    await collections.developer_workflow_run.create_index(
        [("owner_user_id", 1), ("status", 1), ("updated_at", -1)],
        name="developer_workflow_run_owner_status_updated",
    )
    await collections.developer_idempotency.create_index(
        [("api_client_id", 1), ("flow_id", 1), ("idempotency_key", 1)],
        unique=True,
        name="developer_idempotency_unique",
    )
    await collections.developer_idempotency.create_index(
        "expires_at",
        expireAfterSeconds=0,
        name="developer_idempotency_ttl",
    )
    await collections.developer_event_dlq.create_index(
        [("created_at", -1)],
        name="developer_event_dlq_created_at",
    )
    await collections.developer_event_dlq.create_index(
        [("channel_id", 1), ("event_type", 1), ("created_at", -1)],
        name="developer_event_dlq_channel_event_created",
    )


async def ensure_invite_indexes(database: Any) -> None:
    """邀请身份索引。邀请码在用户文档上，关系和发奖各一张表。"""

    collections = owner_collections(database)
    await collections.user.create_index(
        "invite_code",
        unique=True,
        partialFilterExpression={"invite_code": {"$type": "string"}},
        name="invite_codes_invite_code_unique",
    )
    await collections.invite_relations.create_index(
        "invitee_user_id",
        unique=True,
        name="invite_records_invitee_user_id_unique",
    )
    await collections.invite_relations.create_index(
        [("inviter_user_id", 1), ("created_at", -1)],
        name="invite_records_inviter_created",
    )
    await collections.invite_credit_records.create_index(
        [("invitee_user_id", 1), ("reward_type", 1)],
        unique=True,
        name="invite_credit_records_invitee_reward_unique",
    )
    await collections.invite_credit_records.create_index(
        [("inviter_user_id", 1), ("reward_type", 1), ("created_at", -1)],
        name="invite_credit_records_inviter_reward_created",
    )


async def ensure_credits_inout_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.credits_inout_record.create_index(
        [("user_id", 1), ("direction", 1), ("created_at", -1)],
        name="credits_inout_user_direction_created",
    )
    await collections.credits_inout_record.create_index(
        [("event_type", 1), ("created_at", -1)],
        name="credits_inout_event_created",
    )
    await collections.credits_inout_record.create_index(
        "idempotency_key",
        unique=True,
        name="credits_inout_idempotency_unique",
        partialFilterExpression={"idempotency_key": {"$type": "string"}},
    )


async def ensure_subscription_checkout_intent_indexes(database: Any) -> None:
    """先清掉非终态的 expires_at，再挂 TTL。活着的结账认领不能被收走。"""

    collections = owner_collections(database)
    await collections.subscription_checkout_intent.update_many(
        {"state": {"$nin": list(_CHECKOUT_TERMINAL_STATES)}},
        {"$unset": {"expires_at": ""}},
    )
    await collections.subscription_checkout_intent.create_index(
        "expires_at",
        expireAfterSeconds=0,
        name="subscription_checkout_intent_expires_at_ttl",
    )
    await collections.subscription_checkout_intent.create_index(
        "request_id",
        name="subscription_checkout_intent_request_id",
    )
    await collections.orders.create_index(
        "stripe_invoice_id",
        name="order_stripe_invoice_id_lookup",
    )
    await collections.subscription_user_credits.create_index(
        "credit_grant_id",
        name="subscription_user_credits_grant_id_lookup",
    )
    await collections.webhook_events.create_index(
        [
            ("event_provider", 1),
            ("durable_retry_enabled", 1),
            ("status", 1),
            ("next_retry_at", 1),
            ("updated_at", 1),
        ],
        name="webhook_event_durable_retry_lookup",
    )


async def ensure_b2b_signal_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.b2b_signal_events.create_index(
        "event_id",
        unique=True,
        name="b2b_signal_events_event_id_unique",
    )
    await collections.b2b_signal_events.create_index(
        [("user_id", 1), ("event_type", 1), ("created_at", -1)],
        name="b2b_signal_events_user_event_created",
    )
    await collections.b2b_signal_notifications.create_index(
        [("user_id", 1), ("composite_signal_key", 1)],
        unique=True,
        name="b2b_signal_notifications_user_signal_unique",
    )
    await collections.b2b_signal_notifications.create_index(
        [("status", 1), ("updated_at", -1)],
        name="b2b_signal_notifications_status_updated",
    )
    await collections.b2b_signal_actions.create_index(
        [("user_id", 1), ("action_type", 1), ("status", 1), ("created_at", -1)],
        name="b2b_signal_user_actions_user_action_status_created",
    )
    await collections.b2b_signal_actions.create_index(
        [("action_type", 1), ("status", 1), ("eligible_at", 1)],
        name="b2b_signal_user_actions_due_conditional",
    )


async def ensure_media_face_verifications_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.media_face_verifications.create_index(
        [("user_id", 1), ("media.id", 1)],
        unique=True,
        name="media_face_verifications_user_media_unique",
    )
    await collections.media_face_verifications.create_index(
        "media.content_hash",
        name="media_face_verifications_content_hash",
    )
    await collections.media_face_verifications.create_index(
        [("user_id", 1), ("created_at", -1)],
        name="media_face_verifications_user_created",
    )
    await collections.media_face_verifications.create_index(
        [("user_id", 1), ("media.url", 1)],
        name="media_face_verifications_user_media_url",
    )
    await collections.media_face_verifications.create_index(
        [("media.url", 1), ("face_providers.byteplus.asset_id", 1)],
        name="media_face_verifications_url_byteplus_asset",
    )


async def ensure_user_preferences_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.user_preferences.create_index(
        "user_id",
        unique=True,
        name="user_preferences_user_id_unique",
    )


async def ensure_asset_library_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.asset_library_items.create_index(
        "asset_id",
        unique=True,
        name="asset_library_items_asset_id_unique",
    )
    await collections.asset_library_items.create_index(
        [("user_id", 1), ("library_kind", 1), ("url", 1)],
        unique=True,
        name="asset_library_items_user_kind_url_unique",
    )
    await collections.asset_library_items.create_index(
        [
            ("user_id", 1),
            ("library_kind", 1),
            ("media_type", 1),
            ("created_at", -1),
        ],
        name="asset_library_items_user_kind_media_created",
    )
    await collections.results.create_index(
        [
            ("user_id", 1),
            ("status", 1),
            ("type", 1),
            ("metadata.source_kind", 1),
            ("metadata.library_kind", 1),
            ("created_at", -1),
        ],
        name="results_user_asset_source_kind_created",
    )


async def ensure_agent_skill_indexes(database: Any) -> None:
    collections = owner_collections(database)
    await collections.agent_skills.create_index(
        "skill_id",
        unique=True,
        name="agent_skills_skill_id_unique",
    )
    await collections.agent_skills.create_index(
        [("user_id", 1), ("status", 1), ("created_at", -1)],
        name="agent_skills_user_status_created",
    )


async def ensure_agent_catalog_indexes(database: Any) -> None:
    """目录在 `agent_catalog`。hook 和 role 各自按自己的 id 唯一。"""

    collections = owner_collections(database)
    await collections.agent_catalog.create_index(
        "hook_id",
        unique=True,
        partialFilterExpression={"kind": "hook", "hook_id": {"$type": "string"}},
        name="agent_catalog_hook_id_unique",
    )
    await collections.agent_catalog.create_index(
        "role_id",
        unique=True,
        partialFilterExpression={"kind": "role", "role_id": {"$type": "string"}},
        name="agent_catalog_role_id_unique",
    )
    await collections.agent_catalog.create_index(
        [("kind", 1), ("status", 1), ("sort_order", 1), ("updated_at", -1)],
        name="agent_catalog_kind_status_sort",
    )


async def ensure_workflow_v2_indexes(database: Any) -> None:
    """命令和公开任务的唯一键。重复调用不报错。"""

    collections = owner_collections(database)
    await collections.flow_task.create_index(
        [("user_id", 1), ("client_request_id", 1)],
        unique=True,
        partialFilterExpression={"client_request_id": {"$type": "string"}},
        name="flow_task_user_client_request_unique",
    )
    await collections.flow_task.create_index(
        [("user_id", 1), ("protocol_version", 1), ("status", 1), ("updated_at", -1)],
        name="flow_task_user_protocol_status_updated",
    )
    await collections.flow_task.create_index(
        [("flow_task_id", 1), ("protocol_version", 1)],
        name="flow_task_id_protocol",
    )
    await collections.flow_task.create_index(
        [
            ("user_id", 1),
            ("flow_id", 1),
            ("protocol_version", 1),
            ("status", 1),
            ("updated_at", -1),
        ],
        name="flow_task_user_flow_protocol_status_updated",
    )
    await collections.workflow_command.create_index(
        [("user_id", 1), ("command_id", 1)],
        unique=True,
        name="workflow_command_user_command_unique",
    )
    await collections.workflow_command.create_index(
        "wire_command_id",
        unique=True,
        partialFilterExpression={"wire_command_id": {"$type": "string"}},
        name="workflow_command_wire_unique",
    )
    await collections.workflow_command.create_index(
        [("status", 1), ("next_attempt_at", 1), ("updated_at", 1)],
        name="workflow_command_dispatch_due",
    )
    await collections.workflow_command.create_index(
        "expires_at",
        expireAfterSeconds=0,
        name="workflow_command_terminal_ttl",
    )
