import json
from typing import Any

import httpx

from app.config import get_settings

_MESSAGE_SEPARATOR = "-" * 49


def should_block_message(message: str) -> bool:
    keywords = ("Insufficient credits", '"error_code":3003', '"notify_code":3003')
    return any(keyword in message for keyword in keywords)


async def feishu_notify(message: str, is_at: bool = False) -> None:
    if should_block_message(message):
        return
    await _send_feishu_message(message, is_at=is_at)


async def feishu_warring_notify(message: str = "", is_at: bool = False) -> None:
    await _send_feishu_message(f"警告: {message}", is_at=is_at)


async def _send_feishu_message(message: str, is_at: bool = False) -> None:
    settings = get_settings()
    if not settings.feishu_consumer_webhook_url:
        return

    text_payload = {
        "msg_type": "text",
        "content": {"text": _format_text_message(message, is_at=is_at)},
    }
    card_payload = {
        "msg_type": "interactive",
        "card": _build_interactive_card(message, is_at=is_at),
    }

    try:
        await _post_feishu_message(settings.feishu_consumer_webhook_url, card_payload)
    except Exception:
        await _post_feishu_message(settings.feishu_consumer_webhook_url, text_payload)


async def _post_feishu_message(webhook_url: str, payload: dict[str, Any]) -> None:
    settings = get_settings()
    async with httpx.AsyncClient(timeout=settings.feishu_notify_timeout_seconds) as client:
        response = await client.post(webhook_url, json=payload)
        response.raise_for_status()
        result = response.json()
        if result.get("code") not in (None, 0):
            raise RuntimeError(f"Feishu send failed: {result.get('msg')}")


def _format_text_message(message: str, is_at: bool = False) -> str:
    text = "\n".join(
        [
            _MESSAGE_SEPARATOR,
            "NovelComic-Consumer".center(len(_MESSAGE_SEPARATOR)),
            _MESSAGE_SEPARATOR,
            *_extract_message_lines(message),
        ]
    )
    if is_at:
        return f'<at user_id="all">所有人</at>\n{text}'
    return text


def _build_interactive_card(message: str, is_at: bool = False) -> dict[str, Any]:
    content = "\n".join(_extract_message_lines(message))
    if is_at:
        content = f'<at user_id="all">所有人</at>\n{content}'

    return {
        "schema": "2.0",
        "config": {
            "update_multi": True,
            "wide_screen_mode": True,
        },
        "header": {
            "template": _get_card_template(message),
            "title": {
                "tag": "plain_text",
                "content": "NovelComic-Consumer",
            },
            "subtitle": {
                "tag": "plain_text",
                "content": _get_card_subtitle(message),
            },
        },
        "body": {
            "elements": [
                {
                    "tag": "markdown",
                    "element_id": "consumer_alert_content",
                    "content": content,
                    "text_size": "normal",
                },
            ]
        },
    }


def _extract_message_lines(message: str) -> list[str]:
    try:
        parsed = json.loads(message)
    except Exception:
        return message.splitlines() or [message]

    if isinstance(parsed, dict):
        return [f"{key}: {_format_value(value)}" for key, value in parsed.items()]
    if isinstance(parsed, list):
        return [f"{index}: {_format_value(value)}" for index, value in enumerate(parsed, start=1)]
    return [_format_value(parsed)]


def _format_value(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")


def _get_card_subtitle(message: str) -> str:
    parsed = _parse_object_message(message)
    if not parsed:
        return "运行时异常告警"
    return str(parsed.get("notify_title") or parsed.get("notify_type") or "运行时异常告警")


def _get_card_template(message: str) -> str:
    parsed = _parse_object_message(message)
    if not parsed:
        return "red"
    notify_type = str(parsed.get("notify_type") or "")
    notify_body = str(parsed.get("notify_body") or "")
    if notify_type == "HTTPException" and notify_body.startswith("404:"):
        return "orange"
    if notify_type in {"RequestValidationError", "HTTPException", "BaseCustomException"}:
        return "orange"
    return "red"


def _parse_object_message(message: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(message)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None
