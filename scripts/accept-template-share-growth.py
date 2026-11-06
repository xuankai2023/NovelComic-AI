#!/usr/bin/env python3
"""按完整验收顺序跑模板、目录、分享、复制、邀请、Agent 目录和 B2B。

列表能打开不算通过。复制、白名单和入账都要在同一次进程里打到真实接口。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import importlib.util
import json
import logging
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

from app.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.b2b_signal.service import B2BSignalService  # noqa: E402
from app.services.invite import InviteService  # noqa: E402
from app.services.webhook.processors.stripe.SubscriptionSucceedProcessor import (  # noqa: E402
    SubscriptionSucceedProcessor,
)

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_WEBHOOK_SECRET = "whsec_" + base64.b64encode(b"novelcomic-accept-growth").decode()


def _get_nested(document: dict[str, Any], key: str) -> Any:
    current: Any = document
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_nested(document: dict[str, Any], key: str, value: Any) -> None:
    current = document
    parts = key.split(".")
    for part in parts[:-1]:
        nested = current.get(part)
        if not isinstance(nested, dict):
            nested = {}
            current[part] = nested
        current = nested
    current[parts[-1]] = value


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, value in query.items():
        if isinstance(value, dict):
            return False
        if _get_nested(document, key) != value:
            return False
    return True


def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
    if not projection:
        return document
    result = dict(document)
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int) -> FakeCursor:
        self.docs.sort(key=lambda item: item.get(key) or "", reverse=direction < 0)
        return self

    def skip(self, count: int) -> FakeCursor:
        self.docs = self.docs[count:]
        return self

    def limit(self, count: int) -> FakeCursor:
        self.docs = self.docs[:count]
        return self

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        if length is None:
            return list(self.docs)
        return list(self.docs[:length])


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(document)

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        upsert: bool = False,
    ) -> SimpleNamespace:
        for document in self.docs:
            if not _matches(document, query):
                continue
            for key, value in update.get("$set", {}).items():
                _set_nested(document, key, value)
            for key in update.get("$unset", {}):
                document.pop(key, None)
            return SimpleNamespace(matched_count=1, modified_count=1)
        if upsert:
            document = {key: value for key, value in query.items() if not isinstance(value, dict)}
            for key, value in update.get("$set", {}).items():
                _set_nested(document, key, value)
            self.docs.append(document)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def delete_one(self, query: dict[str, Any]) -> SimpleNamespace:
        before = len(self.docs)
        self.docs = [document for document in self.docs if not _matches(document, query)]
        return SimpleNamespace(deleted_count=before - len(self.docs))

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        return FakeCursor(
            [_project(document, projection) for document in self.docs if _matches(document, query)]
        )

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for document in self.docs if _matches(document, query))


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeMongo:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database

    def __getitem__(self, name: str) -> FakeDatabase:
        return self._database

    def close(self) -> None:
        return None


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.writes = 0

    async def set(self, key: str, value: str) -> None:
        self.values[key] = value
        self.writes += 1

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)
        self.writes += 1

    async def aclose(self) -> None:
        return None


class FakeConnections:
    def __init__(self, database: FakeDatabase, redis_client: FakeRedis) -> None:
        self.mongo = FakeMongo(database)
        self.redis = redis_client

    async def close(self) -> None:
        return None


class BoomCollection:
    async def insert_one(self, document: dict[str, Any]) -> None:
        raise RuntimeError("b2b storage down")


class BoomDatabase:
    def __getitem__(self, name: str) -> BoomCollection:
        return BoomCollection()


def _token(sub: str, email: str | None = None) -> str:
    payload: dict[str, Any] = {"sub": sub, "exp": int(time.time()) + 120}
    if email is not None:
        payload["email"] = email
    encoded = jwt.encode(payload, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str, email: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub, email)}"}


def _sign(body: bytes, message_id: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    secret = base64.b64decode(_WEBHOOK_SECRET.removeprefix("whsec_"))
    signed = f"{message_id}.{timestamp}.{body.decode()}".encode()
    digest = hmac.new(secret, signed, hashlib.sha256).digest()
    return {
        "svix-id": message_id,
        "svix-timestamp": timestamp,
        "svix-signature": "v1," + base64.b64encode(digest).decode(),
    }


def _load_consumer_emit():
    path = ROOT / "novelcomic-consumer" / "app" / "services" / "b2b_signal" / "service.py"
    spec = importlib.util.spec_from_file_location("accept_consumer_b2b", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.emit_event


def _check(results: list[dict[str, Any]], step: int, name: str, fn) -> None:
    try:
        detail = fn()
        results.append({"step": step, "name": name, "ok": True, "detail": detail or "ok"})
    except Exception as exc:
        results.append(
            {
                "step": step,
                "name": name,
                "ok": False,
                "detail": f"{type(exc).__name__}: {exc}",
            }
        )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _save_project(client: TestClient, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/api/v2/flow/project", headers=headers, json=body)
    _require(response.status_code == 201, f"save project status={response.status_code} body={response.text}")
    return response.json()["data"]


def _run(database: FakeDatabase, redis_client: FakeRedis) -> list[dict[str, Any]]:
    settings = get_settings()
    settings.clerk_pem_public_key = _PUBLIC_PEM
    settings.internal_api_key = "internal-secret"
    internal_headers = {
        "Authorization": base64.b64encode(b"internal-secret").decode("ascii"),
    }
    settings.clerk_webhook_secret = _WEBHOOK_SECRET
    settings.mongo_database = "novelcomic"
    app = create_app()
    app.state.connections = FakeConnections(database, redis_client)
    client = TestClient(app)
    results: list[dict[str, Any]] = []
    owner = _auth("user_owner", "owner@example.com")
    visitor = _auth("user_visitor", "visitor@example.com")
    stranger = _auth("user_stranger", "stranger@example.com")

    def templates_hide_drafts() -> str:
        database["templates"].docs.extend(
            [
                {
                    "template_id": "published-1",
                    "name": {"zh": "已发布模板"},
                    "status": "published",
                    "origin_flow_id": "flow-published",
                    "share_id": "share-published",
                    "categories": ["story/"],
                },
                {
                    "template_id": "draft-1",
                    "name": {"zh": "草稿模板"},
                    "status": "draft",
                    "categories": ["story/"],
                },
            ]
        )
        page = client.get("/api/v1/templates/page?page_number=1&page_size=20")
        categories = client.get("/api/v1/templates/categories/list")
        _require(
            page.status_code == 200 and categories.status_code == 200,
            "未登录读模板市场失败："
            f"page={page.status_code} {page.text} categories={categories.status_code} {categories.text}",
        )
        _require("Authorization" not in page.request.headers, "模板分页请求不应依赖登录")
        items = page.json()["data"]
        if isinstance(items, dict):
            items = items.get("items") or items.get("list") or []
        identities = []
        for item in items:
            identities.append(item.get("template_id") or item.get("id"))
            _require(item.get("status") in (None, "published"), f"草稿漏出: {item}")
        _require("draft-1" not in identities, f"草稿出现在公开分页: {identities}")
        _require("published-1" in identities, f"已发布模板没有出现: {identities}")
        category_body = categories.json()["data"]
        category_items = category_body if isinstance(category_body, list) else category_body.get("items", [])
        _require(category_items, "分类列表为空")
        _require(
            any(item.get("template_count") for item in category_items),
            f"分类没有 template_count: {category_items}",
        )
        return f"published={identities} categories={len(category_items)}"

    def copy_clears_run_state() -> str:
        source = _save_project(
            client,
            owner,
            {
                "project_name": "Template Source",
                "nodes": [
                    {
                        "id": "node-source",
                        "type": "textInput",
                        "data": {
                            "label": "Prompt",
                            "status": "completed",
                            "generated_data": {"text": "runtime output"},
                        },
                    }
                ],
                "edges": [{"id": "edge-source", "source": "node-source", "target": "node-source"}],
            },
        )
        created = client.post(
            "/api/v3/share",
            headers=owner,
            json={"flow_id": source["flow_id"], "share_type": "workflow"},
        )
        _require(created.status_code == 201, created.text)
        share_id = created.json()["data"]["share_id"]
        info = client.get(f"/api/v3/share/{share_id}/info")
        snapshot = info.json()["data"]["snapshot"]
        _require(snapshot["nodes"][0]["data"]["status"] == "completed", "预览快照应保留创建时的节点")
        _require(snapshot["edges"][0]["id"] == "edge-source", "预览快照应保留创建时的边")
        saved = _save_project(
            client,
            visitor,
            {
                "project_name": snapshot["project_name"],
                "nodes": [
                    {
                        "id": node["id"],
                        "type": node.get("type"),
                        "data": {
                            key: value
                            for key, value in (node.get("data") or {}).items()
                            if key not in {"status", "generated_data", "userStatus", "llm_output"}
                        },
                    }
                    for node in snapshot["nodes"]
                ],
                "edges": snapshot["edges"],
                "parent_flow_id": snapshot["flow_id"],
                "allow_reshare": snapshot["allow_reshare"],
            },
        )
        _require(saved["flow_id"] != source["flow_id"], "Use 没有生成新的 flow_id")
        _require(saved["parent_flow_id"] == source["flow_id"], "parent_flow_id 没有指向来源")
        _require(saved["user_id"] == "user_visitor", "新项目不属于当前用户")
        node_data = saved["nodes"][0]["data"]
        _require("status" not in node_data and "generated_data" not in node_data, f"运行状态还在: {node_data}")
        _require(node_data.get("label") == "Prompt", "节点内容被清掉了")
        _require(database["flow_task"].docs == [], "复制模板时创建了 workflow run")
        return f"new={saved['flow_id']} parent={saved['parent_flow_id']}"

    def public_model_catalog() -> str:
        listed = client.get("/api/v1/models/list?config_name=all")
        ordered = client.get("/api/v1/models/dropdown-order?group=all")
        unknown = client.get("/api/v1/models/dropdown-order?group=bad")
        _require(listed.status_code == 200, listed.text)
        _require(ordered.status_code == 200, ordered.text)
        _require("Authorization" not in listed.request.headers, "模型列表被要求登录")
        _require("Authorization" not in ordered.request.headers, "下拉顺序被要求登录")
        groups = ordered.json()["data"]["groups"]
        _require(
            set(groups) == {
                "atom",
                "text_to_image",
                "image_to_image",
                "text_to_video",
                "image_to_video",
                "all_round_video",
            },
            f"group=all 不是 6 组: {list(groups)}",
        )
        _require(unknown.status_code == 400, f"未知 group 应是 400，实际 {unknown.status_code}")
        return f"models={len(listed.json()['data'])} groups={len(groups)}"

    def upsert_then_sort_keeps_price() -> str:
        created = client.post(
            "/api/internal/model-config/upsert",
            headers=internal_headers,
            json={
                "config_name": "text_to_video_config",
                "model_id": "seedance/pro",
                "display_name": "Seedance Pro",
                "pricing": {"credits": 12},
                "params": {"duration": 5},
            },
        )
        _require(created.status_code == 200, created.text)
        listed = client.get("/api/v1/models/list?config_name=all")
        found = next(item for item in listed.json()["data"] if item["model_id"] == "seedance/pro")
        _require(found["pricing"] == {"credits": 12}, f"公开读没有看到新价格: {found}")
        writes_after_upsert = redis_client.writes
        _require(writes_after_upsert > 0, "upsert 没有刷新 Redis")
        sorted_response = client.post(
            "/api/internal/model-config/dropdown-order/models",
            headers=internal_headers,
            json={
                "items": [
                    {
                        "config_name": "text_to_video_config",
                        "model_id": "seedance/pro",
                        "brand": "Seedance",
                        "released_at": "2026-02-03",
                        "sort_in_brand": 2,
                        "dropdown_groups": ["text_to_video"],
                    }
                ]
            },
        )
        _require(sorted_response.status_code == 200, sorted_response.text)
        _require(redis_client.writes == writes_after_upsert, "只改排序却刷新了 Redis")
        again = client.get("/api/v1/models/list?config_name=all")
        updated = next(item for item in again.json()["data"] if item["model_id"] == "seedance/pro")
        _require(updated["pricing"] == {"credits": 12}, f"排序改写了价格: {updated['pricing']}")
        _require(updated.get("brand") == "seedance", f"排序字段没有写上: {updated}")
        order = client.get("/api/v1/models/dropdown-order?group=text_to_video")
        ids = [item["model_id"] for item in order.json()["data"]["groups"]["text_to_video"]["models"]]
        _require(ids[0] == "seedance/pro", f"下拉顺序没有带上新配置: {ids}")
        return f"price=12 brand={updated.get('brand')} redis_writes={redis_client.writes}"

    def share_snapshot_is_frozen() -> str:
        project = _save_project(
            client,
            owner,
            {
                "project_name": "Frozen Share",
                "nodes": [{"id": "node-original", "data": {"label": "original"}}],
                "edges": [{"id": "edge-original", "source": "node-original", "target": "node-original"}],
            },
        )
        foreign = client.post(
            "/api/v3/share",
            headers=stranger,
            json={"flow_id": project["flow_id"]},
        )
        _require(foreign.status_code == 404, f"别人分享了作者的项目: {foreign.status_code} {foreign.text}")
        created = client.post(
            "/api/v3/share",
            headers=owner,
            json={"flow_id": project["flow_id"], "share_type": "workflow"},
        )
        _require(created.status_code == 201, created.text)
        share_id = created.json()["data"]["share_id"]
        stored = next(
            doc for doc in database["flow_projects"].docs if doc["flow_id"] == project["flow_id"]
        )
        stored["nodes"][0]["id"] = "node-mutated"
        stored["edges"][0]["id"] = "edge-mutated"
        info = client.get(f"/api/v3/share/{share_id}/info")
        _require(info.status_code == 200, info.text)
        snapshot = info.json()["data"]["snapshot"]
        _require(snapshot["nodes"][0]["id"] == "node-original", f"快照跟着源项目变了: {snapshot['nodes']}")
        _require(snapshot["edges"][0]["id"] == "edge-original", f"边快照跟着源项目变了: {snapshot['edges']}")
        return share_id

    def whitelist_visit() -> str:
        project = _save_project(
            client,
            owner,
            {
                "project_name": "Whitelist Share",
                "nodes": [{"id": "node-private", "data": {"label": "private"}}],
                "edges": [],
            },
        )
        open_share = client.post(
            "/api/v3/share",
            headers=owner,
            json={"flow_id": project["flow_id"], "share_type": "workflow"},
        )
        open_id = open_share.json()["data"]["share_id"]
        open_info = client.get(f"/api/v3/share/{open_id}/info")
        _require(open_info.status_code == 200, open_info.text)
        _require(open_info.json()["data"]["need_auth"] is False, "无白名单却要求登录")
        _require(open_info.json()["data"]["snapshot"]["nodes"][0]["id"] == "node-private", "公开 info 没有快照")

        locked = client.post(
            "/api/v3/share",
            headers=owner,
            json={
                "flow_id": project["flow_id"],
                "email_whitelist": ["Visitor@Example.com"],
                "share_type": "workflow",
            },
        )
        _require(locked.status_code == 201, locked.text)
        locked_id = locked.json()["data"]["share_id"]
        locked_info = client.get(f"/api/v3/share/{locked_id}/info")
        _require(locked_info.json()["data"]["need_auth"] is True, "有白名单时 info 仍可直接看图")
        _require(locked_info.json()["data"]["snapshot"] is None, "有白名单时 info 泄漏了快照")
        missing = client.post(f"/api/v3/share/{locked_id}/visit")
        _require(missing.status_code == 401, f"未登录 visit 应是 401，实际 {missing.status_code}")
        denied = client.post(f"/api/v3/share/{locked_id}/visit", headers=stranger)
        _require(denied.status_code == 403, f"邮箱不匹配应是 403，实际 {denied.status_code} {denied.text}")
        allowed = client.post(f"/api/v3/share/{locked_id}/visit", headers=visitor)
        _require(allowed.status_code == 200, allowed.text)
        _require(
            allowed.json()["data"]["snapshot"]["nodes"][0]["id"] == "node-private",
            "匹配邮箱没有拿到快照",
        )
        return locked_id

    def app_flow_does_not_block_share() -> str:
        project = _save_project(
            client,
            owner,
            {
                "project_name": "App And Workflow",
                "nodes": [{"id": "node-app", "data": {"label": "app"}}],
                "edges": [{"id": "edge-app", "source": "node-app", "target": "node-app"}],
            },
        )
        created = client.post(
            "/api/v3/share",
            headers=owner,
            json={"flow_id": project["flow_id"], "share_type": "app_and_workflow"},
        )
        _require(created.status_code == 201, created.text)
        share_id = created.json()["data"]["share_id"]
        missing = client.get(f"/api/v3/app-flow/{project['flow_id']}", headers=visitor)
        _require(missing.status_code == 200, missing.text)
        _require(missing.json()["data"] is None, f"没有 App 记录时应返回 null: {missing.json()}")
        info = client.get(f"/api/v3/share/{share_id}/info")
        _require(info.status_code == 200, info.text)
        _require(info.json()["data"]["snapshot"]["nodes"][0]["id"] == "node-app", "没有 App 记录时分享页打不开")
        app_flow = client.post(
            "/api/v3/app-flow",
            headers=owner,
            json={"flow_id": project["flow_id"], "title": "Companion App"},
        )
        _require(app_flow.status_code == 201, app_flow.text)
        loaded = client.get(f"/api/v3/app-flow/{project['flow_id']}", headers=visitor)
        _require(loaded.json()["data"]["title"] == "Companion App", loaded.text)
        info_again = client.get(f"/api/v3/share/{share_id}/info")
        _require(
            info_again.json()["data"]["snapshot"]["nodes"][0]["id"] == "node-app",
            "补读 App 后分享快照被改写",
        )
        return share_id

    def invite_credits() -> str:
        code = InviteService.generate_invite_code("inviter")
        database["users"].docs.append(
            {"user_id": "inviter", "user_email": "inviter@example.com", "invite_code": code}
        )

        async def _bind_self() -> None:
            relation = await InviteService.bind_registered_user(
                database,
                invitee_user_id="inviter",
                invitee_email="inviter@example.com",
                invite_code=code,
            )
            _require(relation is None, "自己邀请自己仍然建立了关系")

        asyncio.run(_bind_self())
        _require(database["invite_credit_records"].docs == [], "自己邀请自己发了积分")

        def post_created(user_id: str, message_id: str) -> None:
            body = json.dumps(
                {
                    "type": "user.created",
                    "data": {
                        "id": user_id,
                        "email_addresses": [{"email_address": f"{user_id}@example.com"}],
                        "unsafe_metadata": {"inviteCode": code},
                    },
                }
            ).encode()
            response = client.post("/api/v1/user/create", content=body, headers=_sign(body, message_id))
            _require(response.status_code == 200, f"{user_id} webhook {response.status_code} {response.text}")

        post_created("invitee-0", "msg-invitee-0")
        post_created("invitee-0", "msg-invitee-0-dup")
        register_records = [
            doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "register"
        ]
        _require(len(register_records) == 1, f"重复 user.created 多发了注册积分: {len(register_records)}")
        _require(register_records[0]["points"] == 200, f"注册积分不是 200: {register_records[0]}")

        for index in range(1, 11):
            post_created(f"invitee-{index}", f"msg-invitee-{index}")
        register_records = [
            doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "register"
        ]
        _require(len(register_records) == 10, f"注册奖励超过或不足 10 人: {len(register_records)}")
        _require(len(database["invite_relations"].docs) == 11, "第 11 个被邀请人没有留下关系")
        eleventh = next(
            doc for doc in database["invite_relations"].docs if doc["invitee_user_id"] == "invitee-10"
        )
        _require(eleventh["registration_rewarded"] is False, "第 11 人仍然拿到了注册积分")

        now = datetime.now(UTC)
        for doc in database["invite_relations"].docs:
            if doc["invitee_user_id"] == "invitee-0":
                doc["created_at"] = (now - timedelta(days=2)).isoformat()
            if doc["invitee_user_id"] == "invitee-1":
                doc["created_at"] = (now - timedelta(days=8)).isoformat()

        async def _pay(user_id: str, payment_id: str) -> None:
            await SubscriptionSucceedProcessor.process(
                database,
                user_id=user_id,
                subscription_id=payment_id,
                paid_at=now,
            )

        asyncio.run(_pay("invitee-0", "sub-ok"))
        asyncio.run(_pay("invitee-0", "sub-dup"))
        asyncio.run(_pay("invitee-1", "sub-late"))
        paid_records = [doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "paid"]
        _require(len(paid_records) == 1, f"付费积分笔数不是 1: {paid_records}")
        _require(paid_records[0]["points"] == 1000, f"付费积分不是 1000: {paid_records[0]}")
        _require(paid_records[0]["invitee_user_id"] == "invitee-0", "付费积分发给了窗口外的人")

        summary = client.get("/api/v2/user/info", headers=_auth("inviter", "inviter@example.com"))
        _require(summary.status_code == 200, summary.text)
        invite_summary = summary.json()["data"]["invite_summary"]
        _require(invite_summary["invited_count"] == 11, invite_summary)
        _require(invite_summary["register_points"] == 2000, invite_summary)
        _require(invite_summary["paid_points"] == 1000, invite_summary)
        _require(invite_summary["total_points"] == 3000, invite_summary)
        return f"code={code} total={invite_summary['total_points']}"

    def published_catalog() -> str:
        database["agent_catalog"].docs.extend(
            [
                {
                    "kind": "hook",
                    "hook_id": "hook-published",
                    "hook_type": "viral_hooks",
                    "title": {"zh": "已发布钩子"},
                    "status": "published",
                    "prompt": "published",
                },
                {
                    "kind": "hook",
                    "hook_id": "hook-draft",
                    "hook_type": "viral_hooks",
                    "title": {"zh": "草稿钩子"},
                    "status": "draft",
                    "prompt": "draft",
                },
                {
                    "kind": "role",
                    "role_id": "role-published",
                    "title": {"zh": "已发布角色"},
                    "status": "published",
                },
                {
                    "kind": "role",
                    "role_id": "role-draft",
                    "title": {"zh": "草稿角色"},
                    "status": "draft",
                },
            ]
        )
        hooks = client.get("/api/v3/agent-catalog/hooks?hook_type=viral_hooks")
        roles = client.get("/api/v3/agent-catalog/roles")
        _require(hooks.status_code == 200, hooks.text)
        _require(roles.status_code == 200, roles.text)
        hook_ids = [item["hook_id"] for item in hooks.json()["data"]["items"]]
        role_ids = [item["role_id"] for item in roles.json()["data"]["items"]]
        _require(hook_ids == ["hook-published"], f"hooks 草稿漏出或已发布缺失: {hook_ids}")
        _require(role_ids == ["role-published"], f"roles 草稿漏出或已发布缺失: {role_ids}")
        return f"hooks={hook_ids} roles={role_ids}"

    def b2b_isolated() -> str:
        now = datetime.now(UTC)

        async def _emit(user_id: str, event_type: str, source_id: str) -> None:
            await B2BSignalService.emit_event(
                database,
                user_id=user_id,
                event_type=event_type,
                source_id=source_id,
                occurred_at=now,
            )

        asyncio.run(_emit("user-b2b-a", "payment_succeeded", "pay-a"))
        asyncio.run(_emit("user-b2b-a", "credits_deducted", "usage-a"))
        asyncio.run(_emit("user-b2b-b", "payment_succeeded", "pay-b"))
        asyncio.run(_emit("user-b2b-b", "flow_task_started", "task-b"))
        pending_a = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-b2b-a", "a@example.com"))
        pending_b = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-b2b-b", "b@example.com"))
        _require(pending_a.status_code == 200, pending_a.text)
        actions_a = pending_a.json()["data"]
        actions_b = pending_b.json()["data"]
        _require(len(actions_a) == 1 and actions_a[0]["user_id"] == "user-b2b-a", actions_a)
        _require(len(actions_b) == 1 and actions_b[0]["user_id"] == "user-b2b-b", actions_b)
        shown = client.post(
            "/api/v2/b2b-signal/shown",
            headers=_auth("user-b2b-a", "a@example.com"),
            json={"action_id": actions_a[0]["action_id"]},
        )
        _require(shown.status_code == 200, shown.text)
        after = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-b2b-a", "a@example.com"))
        _require(after.json()["data"] == [], f"shown 之后仍返回弹窗: {after.json()}")
        still_b = client.get("/api/v2/b2b-signal/pending", headers=_auth("user-b2b-b", "b@example.com"))
        _require(len(still_b.json()["data"]) == 1, "标记 A 的 shown 影响了 B")

        async def _boom(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("b2b down")

        B2BSignalService.emit_event = _boom  # type: ignore[method-assign]
        runs_before = len(database["flow_task"].docs)
        run = client.post(
            "/api/v2/flow/runs",
            headers=owner,
            json={"flow_id": "flow-b2b", "input_values": {}},
        )
        _require(run.status_code == 202, f"B2B 失败把 run 打失败了: {run.status_code} {run.text}")
        _require(len(database["flow_task"].docs) == runs_before + 1, "run 没有落库")

        async def _pay_anyway() -> None:
            await SubscriptionSucceedProcessor.process(
                database,
                user_id="invitee-0",
                subscription_id="sub-b2b-fail",
                paid_at=datetime.now(UTC),
            )

        asyncio.run(_pay_anyway())
        paid_records = [doc for doc in database["invite_credit_records"].docs if doc["reward_type"] == "paid"]
        _require(len(paid_records) == 1, "B2B 失败让付费入账多发或回滚了")

        async def _consumer() -> None:
            emit_event = _load_consumer_emit()
            await emit_event(
                BoomDatabase(),
                user_id="user-b2b-a",
                event_type="flow_task_started",
                source_id="consumer-task",
            )

        asyncio.run(_consumer())
        return "pending scoped, shown hidden, run and payment survived"

    _check(results, 1, "未登录只看到 published 模板和分类", templates_hide_drafts)
    _check(results, 4, "Use 生成新项目并清掉运行状态", copy_clears_run_state)
    _check(results, 7, "模型列表和下拉顺序可以公开读", public_model_catalog)
    _check(results, 8, "upsert 后公开可读，只改排序不改价格", upsert_then_sort_keeps_price)
    _check(results, 9, "只能分享自己的项目，打开的是创建时快照", share_snapshot_is_frozen)
    _check(results, 10, "白名单 info 不给快照，邮箱不匹配拒绝 visit", whitelist_visit)
    _check(results, 12, "没有 App 记录时分享快照仍可打开", app_flow_does_not_block_share)
    _check(results, 13, "邀请注册积分、10 人上限、7 天付费和重复 webhook", invite_credits)
    _check(results, 15, "未登录只读到 published hooks 和 roles", published_catalog)
    _check(results, 16, "B2B 只弹当前用户，失败不影响支付和 run", b2b_isolated)
    return results


def main() -> int:
    logging.disable(logging.CRITICAL)
    report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    results = _run(FakeDatabase(), FakeRedis())
    payload = json.dumps(results, ensure_ascii=False)
    if report_path is not None:
        report_path.write_text(payload, encoding="utf-8")
    print(f"ACCEPT_JSON {payload}")
    return 0 if all(item["ok"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
