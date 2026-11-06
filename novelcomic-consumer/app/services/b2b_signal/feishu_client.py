"""Consumer-side Feishu card client for B2B upgrade signals."""

import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


class B2BFeishuWebhookError(RuntimeError):
    pass


def build_feishu_interactive_card(action: dict[str, Any]) -> dict[str, Any]:
    metadata = action.get("metadata") if isinstance(action.get("metadata"), dict) else {}
    content = "\n".join(
        [
            f"**用户ID**：{action.get('user_id') or '-'}",
            f"**信号ID**：{action.get('action_id') or action.get('signal_key') or '-'}",
            f"**标题**：{action.get('title') or '-'}",
            f"**说明**：{action.get('description') or '-'}",
            f"**CTA**：[{action.get('cta_text') or '查看'}]({action.get('cta_url') or 'https://www.feishu.cn'})",
            (
                f"**触发事件**："
                f"{action.get('trigger_event_id') or metadata.get('trigger_event_id') or '-'}"
            ),
            f"**创建时间**：{_format_datetime(action.get('created_at'))}",
            f"**过期时间**：{_format_datetime(action.get('expires_at'))}",
        ]
    )
    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "template": "orange",
                "title": {
                    "tag": "plain_text",
                    "content": str(action.get("title") or "B2B 升级信号"),
                },
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {"tag": "lark_md", "content": content},
                }
            ],
        },
    }


class B2BFeishuClient:
    def __init__(
        self,
        *,
        webhook_url: str | None = None,
        timeout: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        settings = get_settings()
        self.webhook_url = (
            webhook_url if webhook_url is not None else settings.b2b_feishu_webhook_url
        )
        self.timeout = timeout if timeout is not None else settings.b2b_feishu_timeout_seconds
        self.transport = transport

    async def send_interactive_card(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.webhook_url:
            log.info("Consumer B2B Feishu webhook is not configured; skip card delivery")
            return {"code": 0, "msg": "skipped"}
        async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
            response = await client.post(self.webhook_url, json=payload)
        response.raise_for_status()
        data = response.json()
        if data.get("code") != 0:
            raise B2BFeishuWebhookError(f"Feishu webhook returned non-zero code: {data}")
        return data

    async def send_expiring_action_card(self, action: dict[str, Any]) -> dict[str, Any]:
        return await self.send_interactive_card(build_feishu_interactive_card(action))


def _format_datetime(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    return "-"
