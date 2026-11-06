"""Lark notifications for custom workflow orders."""

import logging
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

SERVICE_DISPLAY_NAMES = {
    "image_simple": "图片工作流 - 简单场景 (1-8张)",
    "image_batch": "图片工作流 - 批量场景 (8-20张)",
    "video_8s": "视频工作流 - 8秒以内",
    "video_30s": "视频工作流 - 30秒以内",
    "video_60s": "视频工作流 - 60秒左右",
    "workflow_enterprise": "内容生产交付方案",
}


async def send_custom_workflow_order_notification(order: dict[str, Any]) -> bool:
    settings = get_settings()
    if not settings.lark_custom_order_webhook_url:
        log.info(
            "Custom workflow Lark webhook is not configured; skip notification: order_id=%s",
            order.get("order_id"),
        )
        return False

    payload = build_custom_workflow_order_card(order)
    try:
        async with httpx.AsyncClient(timeout=settings.lark_custom_order_timeout_seconds) as client:
            response = await client.post(settings.lark_custom_order_webhook_url, json=payload)
        if response.status_code != 200:
            log.error(
                "Custom workflow Lark notification failed: order_id=%s status=%s body=%s",
                order.get("order_id"),
                response.status_code,
                response.text[:500],
            )
            return False
        data = response.json()
        if data.get("code") not in (None, 0):
            log.error(
                "Custom workflow Lark notification rejected: order_id=%s response=%s",
                order.get("order_id"),
                data,
            )
            return False
        log.info("Custom workflow Lark notification sent: order_id=%s", order.get("order_id"))
        return True
    except Exception as exc:
        log.error(
            "Custom workflow Lark notification error: order_id=%s error=%s",
            order.get("order_id"),
            exc,
            exc_info=True,
        )
        return False


def build_custom_workflow_order_card(order: dict[str, Any]) -> dict[str, Any]:
    service_type = str(order.get("service_type") or order.get("custom_workflow_service_type") or "-")
    service_name = SERVICE_DISPLAY_NAMES.get(service_type, service_type)
    amount_usd = int(order.get("amount") or 0) / 100
    pay_time = _format_pay_time(order.get("paid_at") or order.get("updated_at"))
    title = "新内容生产交付订单" if service_type == "workflow_enterprise" else "新定制工作流订单"

    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "template": "green",
                "title": {"tag": "plain_text", "content": title},
            },
            "elements": [
                {"tag": "markdown", "content": "<at id=all></at>"},
                {"tag": "hr"},
                {"tag": "markdown", "content": f"**订单ID**\n{order.get('order_id') or '-'}"},
                {
                    "tag": "column_set",
                    "flex_mode": "none",
                    "background_style": "grey",
                    "columns": [
                        {
                            "tag": "column",
                            "width": "weighted",
                            "weight": 1,
                            "vertical_align": "top",
                            "elements": [{"tag": "markdown", "content": f"**服务类型**\n{service_name}"}],
                        },
                        {
                            "tag": "column",
                            "width": "weighted",
                            "weight": 1,
                            "vertical_align": "top",
                            "elements": [{"tag": "markdown", "content": f"**金额**\n${amount_usd:.0f}"}],
                        },
                    ],
                },
                {"tag": "hr"},
                {"tag": "markdown", "content": f"**用户邮箱**\n{order.get('customer_email') or '-'}"},
                {"tag": "markdown", "content": f"**用户ID**\n{order.get('user_id') or '-'}"},
                {"tag": "markdown", "content": f"**付款时间**\n{pay_time}"},
            ],
        },
    }


def _format_pay_time(value: Any) -> str:
    utc8 = timezone(timedelta(hours=8))
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(utc8).strftime("%Y-%m-%d %H:%M:%S")
    return datetime.now(utc8).strftime("%Y-%m-%d %H:%M:%S")
