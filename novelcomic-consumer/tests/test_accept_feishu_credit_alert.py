"""Consumer Feishu alerts skip insufficient-credit messages."""

from typing import Any

import pytest

from app.config import get_settings
from app.utils.feishu import feishu_notify


class _Response:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, int]:
        return {"code": 0}


class _Client:
    def __init__(self, timeout: float | None = None) -> None:
        self.timeout = timeout

    async def __aenter__(self) -> "_Client":
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def post(self, url: str, json: dict[str, Any]) -> _Response:
        posted.append((url, json))
        return _Response()


posted: list[tuple[str, dict[str, Any]]] = []


@pytest.mark.asyncio
async def test_consumer_does_not_send_insufficient_credit_alerts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posted.clear()
    monkeypatch.setattr("app.utils.feishu.httpx.AsyncClient", _Client)
    monkeypatch.setattr(
        get_settings(),
        "feishu_consumer_webhook_url",
        "https://consumer.example/hook",
    )

    await feishu_notify("Insufficient credits for user-1")
    await feishu_notify('{"error_code":3003,"msg":"no credits"}')
    await feishu_notify('{"notify_code":3003,"msg":"no credits"}')

    assert posted == []

    await feishu_notify("provider timeout while polling")

    assert len(posted) == 1
    assert posted[0][0] == "https://consumer.example/hook"
    assert posted[0][1]["msg_type"] == "interactive"
    assert "Insufficient credits" not in str(posted[0][1])
