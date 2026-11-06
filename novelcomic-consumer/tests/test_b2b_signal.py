from typing import Any

import pytest

from app.services.b2b_signal.service import emit_event
from app.tasks.flow import emit_flow_task_started
from app.tasks.usage import emit_credits_deducted


class FakeCollection:
    def __init__(self, fail: bool = False) -> None:
        self.docs: list[dict[str, Any]] = []
        self.fail = fail

    async def insert_one(self, document: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("insert failed")
        self.docs.append(dict(document))


class FakeDatabase:
    def __init__(self, fail: bool = False) -> None:
        self.collection = FakeCollection(fail=fail)

    def __getitem__(self, name: str) -> FakeCollection:
        assert name == "b2b_signal_events"
        return self.collection


@pytest.mark.asyncio
async def test_consumer_b2b_helpers_emit_expected_events() -> None:
    database = FakeDatabase()

    await emit_flow_task_started(
        database,
        user_id="user-1",
        flow_task_id="task-1",
        flow_id="flow-1",
    )
    await emit_credits_deducted(
        database,
        user_id="user-1",
        source_id="usage-1",
        credits=25,
    )

    assert [doc["event_type"] for doc in database.collection.docs] == [
        "flow_task_started",
        "credits_deducted",
    ]
    assert database.collection.docs[0]["metadata"] == {"flow_id": "flow-1"}
    assert database.collection.docs[1]["metadata"] == {"credits": 25}


@pytest.mark.asyncio
async def test_consumer_b2b_emit_swallow_errors() -> None:
    database = FakeDatabase(fail=True)

    await emit_event(
        database,
        user_id="user-1",
        event_type="credits_deducted",
        source_id="usage-1",
    )

    assert database.collection.docs == []
