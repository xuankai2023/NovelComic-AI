from __future__ import annotations

import json
from typing import Any

import pytest

from app.config import get_settings
from app.model_gateway.providers.opencreator_ai import (
    ModelProviderRequest,
    OpenCreatorAIProvider,
)
from app.services.opencreator_ai.task_client import OpenCreatorAITaskClient


class RecordingTaskClient:
    def __init__(self) -> None:
        self.auth_key: str | None = None
        self.calls = 0
        self.bodies: list[dict[str, Any]] = []

    async def submit(self, request: Any) -> Any:
        self.calls += 1
        body = request.model_dump(exclude_none=True)
        self.bodies.append(body)

        class Result:
            ai_task_id = "task-1"
            status = "queued"
            existing = False

        return Result()


def request() -> ModelProviderRequest:
    return ModelProviderRequest(
        model_id="kie-image",
        webhook_url="https://consumer.test/callbacks/models/opencreator_ai",
        client_context={"user_id": "user-a", "run_id": "run-1"},
    )


def _clear_auth_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "oc_auth_key", "")
    monkeypatch.setattr(settings, "opencreator_ai_auth_key", "")


@pytest.mark.asyncio
async def test_submit_fails_locally_without_auth_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_auth_keys(monkeypatch)
    client = RecordingTaskClient()
    provider = OpenCreatorAIProvider(client)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="OC_AUTH_KEY"):
        await provider.submit(
            ModelProviderRequest(
                model_id="unmapped-model",
                webhook_url="https://consumer.test/callbacks/models/opencreator_ai",
            )
        )

    assert client.calls == 0


@pytest.mark.asyncio
async def test_submit_uses_oc_auth_key_and_keeps_user_id_in_the_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_auth_keys(monkeypatch)
    settings = get_settings()
    monkeypatch.setattr(settings, "oc_auth_key", "oc-secret")
    monkeypatch.setattr(settings, "opencreator_ai_auth_key", "fallback-secret")
    client = RecordingTaskClient()
    provider = OpenCreatorAIProvider(client)  # type: ignore[arg-type]

    result = await provider.submit(request())

    assert result.external_task_id == "task-1"
    assert client.calls == 1
    assert client.auth_key == "oc-secret"
    assert client.bodies[0]["client_context"]["user_id"] == "user-a"
    assert "auth_key" not in client.bodies[0]


@pytest.mark.asyncio
async def test_submit_falls_back_to_opencreator_ai_auth_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_auth_keys(monkeypatch)
    monkeypatch.setattr(get_settings(), "opencreator_ai_auth_key", "fallback-secret")
    client = RecordingTaskClient()
    provider = OpenCreatorAIProvider(client)  # type: ignore[arg-type]

    await provider.submit(request())

    assert client.auth_key == "fallback-secret"


@pytest.mark.asyncio
async def test_task_client_sends_auth_key_header_and_not_bearer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    class FakeResponse:
        status = 202

        def read(self) -> bytes:
            return b'{"ai_task_id":"task-1","status":"queued"}'

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *_args: object) -> bool:
            return False

    def urlopen(request: Any, timeout: float) -> FakeResponse:
        seen["auth_key"] = request.get_header("Auth_key")
        seen["authorization"] = request.get_header("Authorization")
        seen["body"] = json.loads(request.data.decode("utf-8"))
        seen["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(
        "app.services.opencreator_ai.task_client.urllib.request.urlopen",
        urlopen,
    )
    client = OpenCreatorAITaskClient(
        base_url="http://ai.test",
        timeout_seconds=3,
        auth_key="header-secret",
    )

    task = await client.create_task(
        {
            "model_id": "kie-image",
            "options": {"prompt": "hello"},
            "webhook_url": "https://consumer.test/callbacks/models/opencreator_ai",
            "client_context": {"user_id": "user-a"},
        }
    )

    assert task.ai_task_id == "task-1"
    assert seen["auth_key"] == "header-secret"
    assert seen["authorization"] is None
    assert seen["body"]["client_context"]["user_id"] == "user-a"
    assert "auth_key" not in seen["body"]
    assert seen["timeout"] == 3
