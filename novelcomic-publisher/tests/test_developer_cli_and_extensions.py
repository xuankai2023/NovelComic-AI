"""Tests for Developer API (sk_), CLI Device Auth (ak_), node_blocks, custom_workflow, and miniapp."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app


class _FakeCursor:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self._items = [dict(i) for i in items]

    def sort(self, field: str, direction: int = -1) -> "_FakeCursor":
        reverse = direction < 0
        self._items.sort(key=lambda x: str(x.get(field) or ""), reverse=reverse)
        return self

    def skip(self, count: int) -> "_FakeCursor":
        self._items = self._items[count:]
        return self

    def limit(self, count: int) -> "_FakeCursor":
        self._items = self._items[:count]
        return self

    async def to_list(self, length: int = 100) -> list[dict[str, Any]]:
        return self._items[:length]

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


def _matches(doc: dict[str, Any], query: dict[str, Any]) -> bool:
    for k, v in query.items():
        if k == "$or" and isinstance(v, list):
            if not any(_matches(doc, clause) for clause in v):
                return False
            continue
        actual = doc.get(k)
        if isinstance(v, dict):
            if "$in" in v and actual not in v["$in"]:
                return False
            if "$ne" in v and actual == v["$ne"]:
                return False
            if "$regex" in v:
                pattern = str(v["$regex"]).lower()
                if pattern not in str(actual or "").lower():
                    return False
        elif actual != v:
            return False
    return True


class _FakeCollection:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.docs = list(docs or [])

    async def find_one(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> dict[str, Any] | None:
        del projection
        for doc in self.docs:
            if _matches(doc, query):
                return dict(doc)
        return None

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        **kwargs: Any,
    ) -> dict[str, Any] | None:
        del kwargs
        for doc in self.docs:
            if _matches(doc, query):
                if "$set" in update:
                    doc.update(update["$set"])
                if "$inc" in update:
                    for fk, fv in update["$inc"].items():
                        doc[fk] = int(doc.get(fk, 0) or 0) + int(fv)
                return dict(doc)
        return None

    async def insert_one(self, doc: dict[str, Any], **kwargs: Any) -> Any:
        del kwargs
        stored = dict(doc)
        stored.setdefault("_id", f"id_{len(self.docs) + 1}")
        self.docs.append(stored)
        return SimpleNamespace(inserted_id=stored["_id"])

    async def update_one(self, query: dict[str, Any], update: dict[str, Any], upsert: bool = False, **kwargs: Any) -> Any:
        del kwargs
        for doc in self.docs:
            if _matches(doc, query):
                if "$set" in update:
                    doc.update(update["$set"])
                return SimpleNamespace(matched_count=1, modified_count=1)
        if upsert:
            new_doc = {k: v for k, v in query.items() if not k.startswith("$")}
            if "$set" in update:
                new_doc.update(update["$set"])
            new_doc.setdefault("_id", f"id_{len(self.docs) + 1}")
            self.docs.append(new_doc)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def delete_one(self, query: dict[str, Any], **kwargs: Any) -> Any:
        del kwargs
        for idx, doc in enumerate(self.docs):
            if _matches(doc, query):
                self.docs.pop(idx)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for doc in self.docs if _matches(doc, query))

    def find(self, query: dict[str, Any], projection: dict[str, Any] | None = None) -> _FakeCursor:
        del projection
        matched = [dict(doc) for doc in self.docs if _matches(doc, query)]
        return _FakeCursor(matched)


class _FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, _FakeCollection] = {}

    def __getitem__(self, name: str) -> _FakeCollection:
        if name not in self.collections:
            self.collections[name] = _FakeCollection()
        return self.collections[name]


class _FakeRedis:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.published: list[Any] = []

    async def incr(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key: str, ttl: int) -> None:
        del key, ttl

    async def xadd(self, *args: Any, **kwargs: Any) -> str:
        self.published.append((args, kwargs))
        return "1-0"

    async def rpush(self, *args: Any, **kwargs: Any) -> int:
        self.published.append((args, kwargs))
        return 1


@pytest.fixture()
def client_and_db(monkeypatch: pytest.MonkeyPatch):
    from app.services.jwt import JwtService

    async def fake_payload(token: str) -> dict[str, Any]:
        return {"sub": "user_dev_1", "email": "dev@example.com"}

    monkeypatch.setattr(JwtService, "get_payload_with_backoff", fake_payload)

    fake_db = _FakeDatabase()
    fake_db["user"].docs.append(
        {"id": "user_dev_1", "username": "DevUser", "email": "dev@example.com"}
    )
    fake_db["credits"].docs.append(
        {"user_id": "user_dev_1", "sub_credits": 200, "for_ever_credits": 300, "gift_credits": 500}
    )
    fake_db["templates"].docs.append(
        {
            "template_id": "tpl_1",
            "flow_id": "flow_tpl_1",
            "name": {"zh": "漫剧起步模板", "en": "Comic Starter"},
            "desc": {"zh": "描述", "en": "Desc"},
            "status": "published",
            "nodes": [
                {"id": "node_1", "type": "textInput", "data": {"prompt": "Hero"}},
            ],
            "edges": [],
            "created_at": datetime.now(UTC),
        }
    )
    fake_redis = _FakeRedis()
    app.state.connections = SimpleNamespace(
        mongo={"opencreator": fake_db, "novelcomic": fake_db, "test": fake_db},
        redis=fake_redis,
    )
    return TestClient(app), fake_db


def test_developer_api_key_lifecycle_and_workflow_runs(client_and_db) -> None:
    client, _db = client_and_db
    auth_headers = {"Authorization": "Bearer test_jwt_token"}

    create_res = client.post(
        "/api/v3/developer/api-client",
        json={"name": "CI Key", "rate_limit_per_minute": 10},
        headers=auth_headers,
    )
    assert create_res.status_code == 200
    client_data = create_res.json()["data"]
    sk_key = client_data["api_key"]
    client_id = client_data["client_id"]
    assert sk_key.startswith("sk_")

    list_res = client.get("/api/v3/developer/api-client", headers=auth_headers)
    assert list_res.status_code == 200
    assert len(list_res.json()["data"]) == 1

    # Developer API rejects missing or non-sk_ key
    unauth_res = client.get("/api/developer/v1/templates")
    assert unauth_res.status_code == 401
    bad_key_res = client.get(
        "/api/developer/v1/templates",
        headers={"Authorization": "Bearer ak_invalid"},
    )
    assert bad_key_res.status_code == 401

    # Valid sk_ key can list templates & create workflow from template
    sk_headers = {"X-API-Key": sk_key}
    tpl_res = client.get("/api/developer/v1/templates", headers=sk_headers)
    assert tpl_res.status_code == 200
    assert tpl_res.json()["data"]["total"] == 1

    wf_res = client.post(
        "/api/developer/v1/workflows/from-template",
        json={"template_id": "tpl_1", "project_name": "API Created Flow"},
        headers=sk_headers,
    )
    assert wf_res.status_code == 201
    flow_id = wf_res.json()["data"]["flow_id"]

    params_res = client.get(f"/api/developer/v1/workflows/{flow_id}/parameters", headers=sk_headers)
    assert params_res.status_code == 200
    assert len(params_res.json()["data"]) == 1

    run_res = client.post(
        f"/api/developer/v1/workflows/{flow_id}/runs",
        json={"parameters": {"node_1": {"prompt": "Updated prompt"}}},
        headers=sk_headers,
    )
    assert run_res.status_code == 202
    task_id = run_res.json()["data"]["task_id"]
    assert task_id.startswith("TASK_")

    status_res = client.get(f"/api/developer/v1/workflow-runs/{task_id}", headers=sk_headers)
    assert status_res.status_code == 200
    assert status_res.json()["data"]["task_id"] == task_id

    tasks_list_res = client.get("/api/v1/task/api_client/list", headers=auth_headers)
    assert tasks_list_res.status_code == 200
    assert tasks_list_res.json()["data"]["total"] == 1

    revoke_res = client.delete(f"/api/v3/developer/api-client/{client_id}", headers=auth_headers)
    assert revoke_res.status_code == 200
    after_revoke_res = client.get("/api/developer/v1/templates", headers=sk_headers)
    assert after_revoke_res.status_code == 401


def test_cli_device_authorization_and_ak_token_flow(client_and_db) -> None:
    client, _db = client_and_db
    auth_headers = {"Authorization": "Bearer test_jwt_token"}

    code_res = client.post(
        "/api/v1/cli/device/code",
        json={"client_name": "OpenCreator CLI", "device_name": "MacBook Pro"},
    )
    assert code_res.status_code == 200
    code_data = code_res.json()["data"]
    device_code = code_data["device_code"]
    user_code = code_data["user_code"]
    assert "#code=" in code_data["verification_uri_complete"]

    # Polling before approval returns 400 authorization_pending
    pending_res = client.post("/api/v1/cli/device/token", json={"device_code": device_code})
    assert pending_res.status_code == 400
    assert pending_res.json()["detail"] == "authorization_pending"

    # Browser fetches authorization details & approves
    detail_res = client.get(
        f"/api/v1/cli/device/authorization?user_code={user_code}",
        headers=auth_headers,
    )
    assert detail_res.status_code == 200
    assert detail_res.json()["data"]["status"] == "pending"

    approve_res = client.post(
        "/api/v1/cli/device/authorization",
        json={"user_code": user_code, "action": "approve"},
        headers=auth_headers,
    )
    assert approve_res.status_code == 200
    assert approve_res.json()["data"]["status"] == "approved"

    # CLI exchanges device_code for ak_ token
    token_res = client.post("/api/v1/cli/device/token", json={"device_code": device_code})
    assert token_res.status_code == 200
    ak_token = token_res.json()["data"]["access_token"]
    assert ak_token.startswith("ak_")

    # Replay of same device_code is rejected
    replay_res = client.post("/api/v1/cli/device/token", json={"device_code": device_code})
    assert replay_res.status_code == 400

    # CLI info with ak_ token succeeds; sk_ or Clerk JWT fails on /api/v1/cli/info
    info_res = client.get("/api/v1/cli/info", headers={"Authorization": f"Bearer {ak_token}"})
    assert info_res.status_code == 200
    assert info_res.json()["data"]["credits"] == 1000

    logout_res = client.post("/api/v1/cli/logout", headers={"Authorization": f"Bearer {ak_token}"})
    assert logout_res.status_code == 200
    after_logout = client.get("/api/v1/cli/info", headers={"Authorization": f"Bearer {ak_token}"})
    assert after_logout.status_code == 401


def test_node_blocks_custom_workflow_and_miniapp_endpoints(client_and_db) -> None:
    client, _db = client_and_db
    auth_headers = {"Authorization": "Bearer test_jwt_token"}

    # Node blocks CRUD
    nb_create = client.post(
        "/api/v1/node_blocks",
        json={"name": "Three-angle Shot", "nodes": [{"id": "n1"}], "edges": []},
        headers=auth_headers,
    )
    assert nb_create.status_code == 200
    block_id = nb_create.json()["data"]["block_id"]

    nb_page = client.get("/api/v1/node_blocks/page", headers=auth_headers)
    assert nb_page.status_code == 200
    assert nb_page.json()["data"]["total"] == 1

    nb_patch = client.patch(
        f"/api/v1/node_blocks/{block_id}",
        json={"name": "Updated Block"},
        headers=auth_headers,
    )
    assert nb_patch.status_code == 200
    assert nb_patch.json()["data"]["name"] == "Updated Block"

    nb_del = client.delete(f"/api/v1/node_blocks/{block_id}", headers=auth_headers)
    assert nb_del.status_code == 200

    # Custom workflow orders
    cwo_checkout = client.post(
        "/api/v1/custom_workflow/checkout",
        json={"title": "Anime MV Pipeline", "requirements": "Need 12 scenes", "budget_usd": 299},
        headers=auth_headers,
    )
    assert cwo_checkout.status_code == 200
    order_id = cwo_checkout.json()["data"]["order_id"]

    cwo_list = client.get("/api/v1/custom_workflow/orders", headers=auth_headers)
    assert cwo_list.status_code == 200
    assert cwo_list.json()["data"]["total"] == 1

    cwo_detail = client.get(f"/api/v1/custom_workflow/orders/{order_id}", headers=auth_headers)
    assert cwo_detail.status_code == 200
    assert cwo_detail.json()["data"]["order_id"] == order_id

    # Miniapp tasks
    ma_create = client.post(
        "/api/v1/miniapp/create_task",
        json={"miniapp_id": "app_comic_avatar", "inputs": {"style": "cyberpunk"}},
        headers=auth_headers,
    )
    assert ma_create.status_code == 200
    ma_task_id = ma_create.json()["data"]["task_id"]

    ma_get = client.get(f"/api/v1/miniapp/get_task/{ma_task_id}", headers=auth_headers)
    assert ma_get.status_code == 200
    assert ma_get.json()["data"]["miniapp_id"] == "app_comic_avatar"

    ma_list = client.get("/api/v1/miniapp/get_list/app_comic_avatar", headers=auth_headers)
    assert ma_list.status_code == 200
    assert ma_list.json()["data"]["total"] == 1
