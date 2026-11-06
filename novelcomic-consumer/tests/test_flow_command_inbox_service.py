from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pymongo.errors import DuplicateKeyError

from app.services.workflow.flow_command_inbox_service import FlowCommandInboxService


class UpdateResult:
    def __init__(self, modified_count: int) -> None:
        self.modified_count = modified_count


class FakeInbox:
    def __init__(self) -> None:
        self.docs: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _condition_matches(document: dict[str, Any], condition: dict[str, Any]) -> bool:
        for field, expected in condition.items():
            actual = document.get(field)
            if isinstance(expected, dict):
                if "$lte" in expected and not (actual is not None and actual <= expected["$lte"]):
                    return False
                if "$exists" in expected and (field in document) != expected["$exists"]:
                    return False
                if "$type" in expected and expected["$type"] == "object" and not isinstance(actual, dict):
                    return False
            elif actual != expected:
                return False
        return True

    @classmethod
    def _query_matches(cls, document: dict[str, Any], query: dict[str, Any]) -> bool:
        identity = {key: value for key, value in query.items() if key not in {"$or", "$and"}}
        if not cls._condition_matches(document, identity):
            return False
        if "$or" in query and not any(cls._query_matches(document, branch) for branch in query["$or"]):
            return False
        return all(cls._query_matches(document, branch) for branch in query.get("$and", []))

    @staticmethod
    def _apply_update(document: dict[str, Any], update: dict[str, Any]) -> None:
        for key, value in update.get("$set", {}).items():
            document[key] = deepcopy(value)
        for key, value in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + value
        for key in update.get("$unset", {}):
            document.pop(key, None)

    async def find_one_and_update(self, query: dict[str, Any], update: dict[str, Any], **_kwargs: Any):
        command_id = query.get("_id")
        existing = self.docs.get(command_id) if command_id else next(
            (doc for doc in self.docs.values() if self._query_matches(doc, query)),
            None,
        )
        if existing is None:
            if not command_id or "$setOnInsert" not in update:
                return None
            document = deepcopy(update["$setOnInsert"])
            self._apply_update(document, update)
            self.docs[command_id] = document
            return deepcopy(document)
        if not self._query_matches(existing, query):
            raise DuplicateKeyError("duplicate command_id")
        self._apply_update(existing, update)
        return deepcopy(existing)

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        document = self.docs.get(query["_id"])
        return deepcopy(document) if document is not None else None

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> UpdateResult:
        document = self.docs.get(query["_id"])
        if document is None or not self._condition_matches(document, query):
            return UpdateResult(0)
        self._apply_update(document, update)
        return UpdateResult(1)


class InboxDatabase:
    def __init__(self, collection: FakeInbox) -> None:
        self.collection = collection

    def __getitem__(self, name: str) -> FakeInbox:
        assert name == FlowCommandInboxService.COLLECTION
        return self.collection


def command(**overrides: Any) -> dict[str, Any]:
    base = {
        "command_id": "cmd_1",
        "protocol_version": 2,
        "command_type": "start",
        "flow_task_id": "task_1",
        "flow_run_id": "run_1",
        "payload": {"dag": {"nodes": []}},
        "redelivery_payload": {"flow_task_id": "task_1", "command_id": "cmd_1"},
    }
    base.update(overrides)
    return base


@pytest.fixture
def inbox(monkeypatch: pytest.MonkeyPatch) -> tuple[InboxDatabase, FakeInbox, dict[str, datetime]]:
    collection = FakeInbox()
    clock = {"now": datetime(2026, 9, 30, 12, 0, tzinfo=UTC)}
    tokens = iter(f"lease_{index}" for index in range(1, 20))
    monkeypatch.setattr(FlowCommandInboxService, "_now", staticmethod(lambda: clock["now"]))
    monkeypatch.setattr(FlowCommandInboxService, "_new_lease_token", staticmethod(lambda: next(tokens)))
    return InboxDatabase(collection), collection, clock


@pytest.mark.asyncio
async def test_same_payload_is_not_claimed_twice_and_a_changed_identity_conflicts(
    inbox: tuple[InboxDatabase, FakeInbox, dict[str, datetime]],
) -> None:
    database, collection, _clock = inbox
    first = await FlowCommandInboxService.claim_command(database, **command())
    second = await FlowCommandInboxService.claim_command(database, **command())

    assert first.claimed is True
    assert second.claimed is False
    assert second.conflict is False
    assert collection.docs["cmd_1"]["attempts"] == 1

    conflict = await FlowCommandInboxService.claim_command(
        database,
        **command(flow_run_id="run_other"),
    )
    assert conflict.claimed is False
    assert conflict.conflict is True
    assert collection.docs["cmd_1"]["flow_run_id"] == "run_1"
    assert collection.docs["cmd_1"]["attempts"] == 1
    assert collection.docs["cmd_1"]["lease_token"] == first.lease_token


@pytest.mark.asyncio
async def test_expired_processing_lease_can_be_reclaimed(
    inbox: tuple[InboxDatabase, FakeInbox, dict[str, datetime]],
) -> None:
    database, collection, clock = inbox
    first = await FlowCommandInboxService.claim_command(database, **command())
    clock["now"] += timedelta(seconds=301)
    reclaimed = await FlowCommandInboxService.claim_command(database, **command())

    assert reclaimed.claimed is True
    assert reclaimed.lease_token != first.lease_token
    assert collection.docs["cmd_1"]["attempts"] == 2
    assert await FlowCommandInboxService.mark_completed(database, "cmd_1", first.lease_token or "") is False
    assert collection.docs["cmd_1"]["status"] == "processing"


@pytest.mark.asyncio
async def test_wrong_lease_cannot_complete_and_failure_clears_expiry(
    inbox: tuple[InboxDatabase, FakeInbox, dict[str, datetime]],
) -> None:
    database, collection, clock = inbox
    first = await FlowCommandInboxService.claim_command(database, **command())
    assert first.lease_token is not None

    assert await FlowCommandInboxService.mark_completed(database, "cmd_1", "wrong-token") is False
    assert collection.docs["cmd_1"]["status"] == "processing"
    assert "expires_at" not in collection.docs["cmd_1"]

    assert await FlowCommandInboxService.mark_failed(database, "cmd_1", first.lease_token, "boom") is True
    assert collection.docs["cmd_1"]["status"] == "failed"
    assert "expires_at" not in collection.docs["cmd_1"]

    assert await FlowCommandInboxService.mark_completed(database, "cmd_1", first.lease_token) is False
    clock["now"] += timedelta(seconds=5)
    retried = await FlowCommandInboxService.claim_command(database, **command())
    assert retried.claimed is True
    assert await FlowCommandInboxService.mark_completed(database, "cmd_1", retried.lease_token or "") is True
    assert collection.docs["cmd_1"]["status"] == "completed"
    assert collection.docs["cmd_1"]["expires_at"] == clock["now"] + timedelta(days=7)


@pytest.mark.asyncio
async def test_expired_processing_command_can_be_redelivered(
    inbox: tuple[InboxDatabase, FakeInbox, dict[str, datetime]],
) -> None:
    database, collection, clock = inbox
    await FlowCommandInboxService.claim_command(database, **command())
    assert await FlowCommandInboxService.claim_due_redelivery(database) is None

    clock["now"] += timedelta(seconds=301)
    due = await FlowCommandInboxService.claim_due_redelivery(database)
    assert due is not None
    assert due["command_id"] == "cmd_1"
    assert due["redelivery_attempts"] == 1
    token = due["redelivery_lease_token"]
    assert await FlowCommandInboxService.mark_redelivery_enqueued(database, "cmd_1", token) is True
    assert "redelivery_lease_token" not in collection.docs["cmd_1"]

    clock["now"] += timedelta(seconds=31)
    again = await FlowCommandInboxService.claim_due_redelivery(database)
    assert again is not None
    assert await FlowCommandInboxService.mark_redelivery_failed(
        database,
        "cmd_1",
        again["redelivery_lease_token"],
        "redis down",
    ) is True
    assert collection.docs["cmd_1"]["redelivery_error"] == "redis down"
