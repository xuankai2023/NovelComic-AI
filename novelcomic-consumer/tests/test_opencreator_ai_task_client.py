from __future__ import annotations

import pytest

from app.services.opencreator_ai.schemas import CreateTaskRequest
from app.services.opencreator_ai.task_client import (
    OpenCreatorAISubmitError,
    OpenCreatorAITaskClient,
)


class FakeTaskClient(OpenCreatorAITaskClient):
    def __init__(self, status_code: int, payload: dict) -> None:
        super().__init__(base_url="http://ai.test", timeout_seconds=1)
        self.status_code = status_code
        self.payload = payload

    def _post_json(self, body: dict) -> tuple[int, dict]:
        self.last_body = body
        return self.status_code, self.payload


def request() -> CreateTaskRequest:
    return CreateTaskRequest(
        model_id="model-1",
        options={"prompt": "hello"},
        webhook_url="https://consumer.test/v1/ai/tasks/callback",
        idempotency_key="idem-1",
        client_context={"run_id": "run-1"},
    )


@pytest.mark.asyncio
async def test_create_task_returns_new_task() -> None:
    client = FakeTaskClient(202, {"ai_task_id": "task-1", "status": "queued"})

    task = await client.create_task(request())

    assert task.ai_task_id == "task-1"
    assert task.status == "queued"
    assert task.existing is False
    assert client.last_body["idempotency_key"] == "idem-1"


@pytest.mark.asyncio
async def test_create_task_returns_existing_task_for_200() -> None:
    client = FakeTaskClient(200, {"ai_task_id": "task-1", "status": "existing"})

    task = await client.create_task(request())

    assert task.ai_task_id == "task-1"
    assert task.status == "existing"
    assert task.existing is True


@pytest.mark.asyncio
async def test_create_task_rejects_unexpected_status() -> None:
    client = FakeTaskClient(500, {"code": 500, "msg": "boom"})

    with pytest.raises(OpenCreatorAISubmitError) as exc:
        await client.create_task(request())

    assert exc.value.status_code == 500
