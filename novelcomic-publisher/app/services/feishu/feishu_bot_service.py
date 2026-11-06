"""Send receipt messages through the configured Feishu bot webhook."""

import logging

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


class FeishuBotService:
    @classmethod
    async def send_text(cls, text: str) -> bool:
        webhook = get_settings().feishu_bot_webhook
        if not webhook:
            log.warning("FEISHU_BOT_WEBHOOK is not configured, skip Feishu receipt")
            return False

        payload = {"msg_type": "text", "content": {"text": text}}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(webhook, json=payload)
            if response.status_code != 200:
                log.warning("Feishu bot webhook failed: status=%s", response.status_code)
                return False
            result = response.json()
        except Exception:
            log.exception("Failed to send Feishu bot receipt")
            return False

        success = result.get("code") == 0
        if not success:
            log.warning("Feishu bot webhook returned non-zero code: result=%s", result)
        return success
