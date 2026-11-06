"""Rules that turn product/payment events into B2B upgrade prompts."""

from datetime import UTC, datetime, timedelta
from typing import Any

B2B_UPGRADE_ACTION_ID = "b2b_upgrade_consultation"
REQUIRED_ACTIVITY_EVENTS = {"flow_task_started", "credits_deducted"}
QUALIFYING_PAYMENT_EVENTS = {"payment_succeeded"}


def should_create_upgrade_action(events: list[dict[str, Any]]) -> bool:
    event_types = {str(event.get("event_type")) for event in events}
    return bool(event_types & REQUIRED_ACTIVITY_EVENTS) and bool(
        event_types & QUALIFYING_PAYMENT_EVENTS
    )


def build_upgrade_action(user_id: str, now: datetime | None = None) -> dict[str, Any]:
    created_at = now or datetime.now(UTC)
    return {
        "action_id": B2B_UPGRADE_ACTION_ID,
        "user_id": user_id,
        "status": "pending",
        "title": "团队创作加速包",
        "description": "检测到你正在高频使用创作工作流，可以预约顾问获取团队额度与交付支持。",
        "cta_text": "预约顾问",
        "cta_url": "https://www.feishu.cn",
        "created_at": created_at,
        "updated_at": created_at,
        "expires_at": created_at + timedelta(days=7),
    }
