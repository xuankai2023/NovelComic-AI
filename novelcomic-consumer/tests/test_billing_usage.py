from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

import pytest
from pymongo.errors import DuplicateKeyError

from app.services.billing.credit_balance_check_service_v2 import CreditBalanceCheckServiceV2
from app.tasks.usage import UsageTask


class UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count
        self.modified_count = matched_count


class FakeCollection:
    def __init__(self) -> None:
        self.docs: dict[Any, dict[str, Any]] = {}

    @staticmethod
    def _identity(document: dict[str, Any]) -> Any:
        return (
            document.get("_id")
            or document.get("user_id")
            or document.get("deduction_id")
            or document.get("idempotency_key")
            or id(document)
        )

    def _matches(self, document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                continue
            if actual != expected:
                return False
        return True

    @staticmethod
    def _apply(document: dict[str, Any], update: dict[str, Any], *, inserted: bool) -> None:
        if inserted:
            document.update(deepcopy(update.get("$setOnInsert", {})))
        document.update(deepcopy(update.get("$set", {})))
        for key, value in update.get("$inc", {}).items():
            document[key] = int(document.get(key) or 0) + int(value)

    async def insert_one(self, document: dict[str, Any]) -> None:
        identity = self._identity(document)
        if identity in self.docs:
            raise DuplicateKeyError("duplicate")
        self.docs[identity] = deepcopy(document)

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        for document in self.docs.values():
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        upsert: bool = False,
    ) -> UpdateResult:
        for identity, document in self.docs.items():
            if self._matches(document, query):
                next_doc = deepcopy(document)
                self._apply(next_doc, update, inserted=False)
                self.docs[identity] = next_doc
                return UpdateResult(1)
        if not upsert:
            return UpdateResult(0)
        document = {key: value for key, value in query.items() if not key.startswith("$")}
        self._apply(document, update, inserted=True)
        self.docs[self._identity(document)] = document
        return UpdateResult(1)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def exists(self, key: str) -> int:
        return int(key in self.values)

    async def set(self, key: str, value: Any, *, ex: int | None = None, nx: bool = False) -> bool:
        del ex
        if nx and key in self.values:
            return False
        self.values[key] = str(value)
        return True

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def delete(self, key: str) -> int:
        existed = key in self.values
        self.values.pop(key, None)
        return int(existed)

    async def eval(self, script: str, numkeys: int, *args: Any) -> list[int]:
        del script
        keys = [str(item) for item in args[:numkeys]]
        argv = args[numkeys:]
        if numkeys == 4:
            return self._pre_deduct(keys, argv)
        return self._rollback(keys, argv)

    def _pre_deduct(self, keys: list[str], argv: tuple[Any, ...]) -> list[int]:
        subscription_key, user_key, gift_key, pending_key = keys
        cost = int(argv[0])
        deduction_id = str(argv[1])
        user_id = str(argv[2])
        subscription = int(self.values.get(subscription_key, "0"))
        user = int(self.values.get(user_key, "0"))
        gift_data = json.loads(self.values.get(gift_key, '{"amount":"0"}'))
        gift = int(gift_data.get("amount") or 0)
        if subscription + user + gift < cost:
            return [-1, 0, 0, 0]
        remaining = cost
        sub_deducted = min(subscription, remaining)
        remaining -= sub_deducted
        user_deducted = min(user, remaining)
        remaining -= user_deducted
        gift_deducted = min(gift, remaining)
        self.values[subscription_key] = str(subscription - sub_deducted)
        self.values[user_key] = str(user - user_deducted)
        gift_data["amount"] = str(gift - gift_deducted)
        self.values[gift_key] = json.dumps(gift_data)
        self.values[pending_key] = json.dumps(
            {
                "deduction_id": deduction_id,
                "user_id": user_id,
                "cost": cost,
                "subscription": sub_deducted,
                "topup": user_deducted,
                "gift": gift_deducted,
            }
        )
        return [subscription + user + gift - cost, sub_deducted, user_deducted, gift_deducted]

    def _rollback(self, keys: list[str], argv: tuple[Any, ...]) -> list[int]:
        subscription_key, user_key, gift_key = keys
        sub_amount, user_amount, gift_amount = (int(item or 0) for item in argv[:3])
        self.values[subscription_key] = str(
            int(self.values.get(subscription_key, "0")) + sub_amount
        )
        self.values[user_key] = str(int(self.values.get(user_key, "0")) + user_amount)
        gift_data = json.loads(self.values.get(gift_key, '{"amount":"0"}'))
        gift_data["amount"] = str(int(gift_data.get("amount") or 0) + gift_amount)
        self.values[gift_key] = json.dumps(gift_data)
        return [1]


async def _seed_three_pools(database: FakeDatabase) -> None:
    await database["users"].insert_one({"user_id": "user-1", "credits": 20, "user_email": "u@test"})
    await database["subscription_user_credits"].insert_one(
        {"user_id": "user-1", "status": "active", "credits_balance": 5}
    )
    await database["gift_credits"].insert_one({"user_id": "user-1", "amount": 10})


@pytest.mark.asyncio
async def test_pre_deduction_only_updates_redis_and_writes_pending() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_three_pools(database)

    ok, sub, topup, gift, deduction_id = await CreditBalanceCheckServiceV2.check_for_pre_deduction(
        database,
        redis,
        user_id="user-1",
        pre_deduct_cost=18,
    )

    assert ok is True
    assert (sub, topup, gift) == (5, 13, 0)
    assert deduction_id
    assert await redis.get(CreditBalanceCheckServiceV2.subscription_credits_key("user-1")) == "0"
    assert await redis.get(CreditBalanceCheckServiceV2.user_credits_key("user-1")) == "7"
    assert (await database["users"].find_one({"user_id": "user-1"}))["credits"] == 20
    assert not database["usage_v2"].docs


@pytest.mark.asyncio
async def test_usage_confirmation_deducts_mongo_once_and_deletes_pending() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_three_pools(database)
    ok, sub, topup, gift, deduction_id = await CreditBalanceCheckServiceV2.check_for_pre_deduction(
        database,
        redis,
        user_id="user-1",
        pre_deduct_cost=18,
    )
    assert ok is True
    invocation = {
        "_id": "inv-1",
        "user_id": "user-1",
        "model_id": "m1",
        "run_id": "run-1",
        "node_id": "node-1",
        "result_id": "result-1",
        "metadata": {
            "deduction": {
                "deduction_id": deduction_id,
                "deduction_cost": 18,
                "subscription_user_credits_deducted_amount": sub,
                "user_credits_deducted_amount": topup,
                "gift_credits_deducted_amount": gift,
            }
        },
    }
    await database["model_invocations"].insert_one(invocation)

    await UsageTask.handle_consume(database, redis_client=redis, invocation=invocation)
    await UsageTask.handle_consume(database, redis_client=redis, invocation=invocation)

    assert (await database["subscription_user_credits"].find_one({"user_id": "user-1"}))[
        "credits_balance"
    ] == 0
    assert (await database["users"].find_one({"user_id": "user-1"}))["credits"] == 7
    usage = await database["usage_v2"].find_one({"deduction_id": deduction_id})
    assert usage["deduction_status"] == "deducted"
    assert len(database["credits_inout_record"].docs) == 1
    ledger = next(iter(database["credits_inout_record"].docs.values()))
    assert ledger["event_type"] == "usage_deduct"
    assert ledger["direction"] == "out"
    assert ledger["amount"] == 18
    assert await redis.get(CreditBalanceCheckServiceV2.pending_key(deduction_id)) is None


@pytest.mark.asyncio
async def test_rollback_restores_redis_and_does_not_create_usage() -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    await _seed_three_pools(database)
    ok, sub, topup, gift, deduction_id = await CreditBalanceCheckServiceV2.check_for_pre_deduction(
        database,
        redis,
        user_id="user-1",
        pre_deduct_cost=18,
    )
    assert ok is True

    await CreditBalanceCheckServiceV2.rollback_deduct(
        database,
        redis,
        user_id="user-1",
        subscription_user_credits_deducted_amount=sub,
        user_credits_deducted_amount=topup,
        gift_credits_deducted_amount=gift,
        deduction_id=deduction_id,
    )

    assert await redis.get(CreditBalanceCheckServiceV2.subscription_credits_key("user-1")) == "5"
    assert await redis.get(CreditBalanceCheckServiceV2.user_credits_key("user-1")) == "20"
    assert await redis.get(CreditBalanceCheckServiceV2.pending_key(deduction_id)) is None
    assert not database["usage_v2"].docs
