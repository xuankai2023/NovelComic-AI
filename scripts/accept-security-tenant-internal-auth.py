#!/usr/bin/env python3
"""按安全租户与内部鉴权的 10 条验收顺序打证据。

用法：
  novelcomic-publisher/.venv/bin/python scripts/accept-security-tenant-internal-auth.py
"""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import hmac
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import traceback
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
_VENV_PYTHON = ROOT / "novelcomic-publisher" / ".venv" / "bin" / "python"
if _VENV_PYTHON.exists() and Path(sys.executable).resolve() != _VENV_PYTHON.resolve():
    if os.environ.get("NOVELCOMIC_ACCEPT_SECURITY_PY") != "1":
        os.environ["NOVELCOMIC_ACCEPT_SECURITY_PY"] = "1"
        os.execv(_VENV_PYTHON, [str(_VENV_PYTHON), *sys.argv])

sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

import httpx  # noqa: E402
import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.dependencies.authenticated_user import get_authenticated_user  # noqa: E402
from app.main import create_app  # noqa: E402

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_STEP_TITLES = [
    "未登录的业务 HTTP 发不出去。登录后 request.user.user_id 等于 JWT sub",
    "用户 A 的 JWT 读取用户 B 的 flow、run、结果，结果与不存在相同。请求体里的 user_id 改变不了查询",
    "WebSocket 首包不是 auth 则 4401。run 属于别人则 4404。authenticated 之后的下一条不是 attach_flow 则 4400",
    "snapshot 无密钥或密钥错误为 401，密钥未配置为 503。用户 JWT 打在 snapshot 上为 401。比对用 compare_digest",
    "Publisher /internal 在密钥通过后，资源主人来自请求体里的 user_id",
    "AI /v1/tasks 缺 auth_key 为 401。/v1/provider-webhooks/tencent 签名错误为 403",
    "回调 body 改一个字节为 401。NovelComic 上时间窗外的 x-oc-timestamp 仍为 401。密钥未配置记成未验签放行",
    "Agent 非法 JWT 为 401。user_id 来自 sub。别人的 session 或 run 为 403。未配置公共 chat 时，无 Bearer 为 401",
    "Agent 查 flow 的条件含认证 user_id",
    "内网和元数据地址在连接前被拒绝。重定向到内网的最终 URL 被第二次拒绝",
]
_OUT_OF_SCOPE = "登录发码、画布页面前禁、DAG、cursor 和厂商 payload 字段分别看对应那组。"


class UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count
        self.modified_count = matched_count


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int = 1) -> FakeCursor:
        self.docs = sorted(
            self.docs,
            key=lambda document: (document.get(key) is None, str(document.get(key))),
            reverse=direction < 0,
        )
        return self

    def limit(self, count: int) -> FakeCursor:
        self.docs = self.docs[:count]
        return self

    def __aiter__(self) -> FakeCursor:
        self._iter = iter(self.docs)
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []
        self.queries: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            if key == "$or":
                if not any(FakeCollection._matches(document, branch) for branch in expected):
                    return False
                continue
            actual = document.get(key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$exists" in expected:
                    exists = key in document and document.get(key) is not None
                    if exists != bool(expected["$exists"]):
                        return False
                continue
            if actual != expected:
                return False
        return True

    @staticmethod
    def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
        output = copy.deepcopy(document)
        for key, flag in (projection or {}).items():
            if flag == 0:
                output.pop(key, None)
        return output

    @staticmethod
    def _apply(document: dict[str, Any], update: dict[str, Any]) -> None:
        for key, value in update.get("$set", {}).items():
            if "." not in key:
                document[key] = copy.deepcopy(value)
                continue
            current = document
            parts = key.split(".")
            for part in parts[:-1]:
                nested = current.get(part)
                if not isinstance(nested, dict):
                    nested = {}
                    current[part] = nested
                current = nested
            current[parts[-1]] = copy.deepcopy(value)

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
        *_args: Any,
        **_kwargs: Any,
    ) -> dict[str, Any] | None:
        self.queries.append(copy.deepcopy(query))
        for document in self.docs:
            if self._matches(document, query):
                return self._project(document, projection)
        return None

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
        *_args: Any,
        **_kwargs: Any,
    ) -> FakeCursor:
        self.queries.append(copy.deepcopy(query))
        matched = [
            self._project(document, projection)
            for document in self.docs
            if self._matches(document, query)
        ]
        return FakeCursor(matched)

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        **_kwargs: Any,
    ) -> UpdateResult:
        self.queries.append(copy.deepcopy(query))
        for document in self.docs:
            if self._matches(document, query):
                self._apply(document, update)
                return UpdateResult(1)
        return UpdateResult(0)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


@asynccontextmanager
async def _skip_lifespan(_app: FastAPI):
    yield


def _token(sub: str, *, expired: bool = False) -> str:
    exp = int(datetime.now(UTC).timestamp()) + (-30 if expired else 120)
    encoded = jwt.encode({"sub": sub, "exp": exp}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def _service_key(key: str) -> dict[str, str]:
    return {"Authorization": base64.b64encode(key.encode("utf-8")).decode("ascii")}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _format_error(exc: BaseException) -> str:
    text = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    return text or exc.__class__.__name__


def _record(results: dict[int, dict[str, Any]], step: int, detail: str) -> None:
    results[step] = {"step": step, "name": _STEP_TITLES[step - 1], "ok": True, "detail": detail}


def _fail(results: dict[int, dict[str, Any]], step: int, exc: BaseException) -> None:
    results[step] = {
        "step": step,
        "name": _STEP_TITLES[step - 1],
        "ok": False,
        "detail": _format_error(exc),
    }


def _publisher_client(database: FakeDatabase) -> TestClient:
    settings = get_settings()
    settings.clerk_pem_public_key = _PUBLIC_PEM
    app = create_app()
    app.router.lifespan_context = _skip_lifespan

    @app.get("/api/v2/whoami")
    def whoami(request: Request) -> dict[str, str]:
        user = get_authenticated_user(request)
        return {"user_id": user.user_id}

    app.state.connections = SimpleNamespace(
        mongo={settings.mongo_database: database},
        redis=SimpleNamespace(),
    )
    return TestClient(app)


def _run_publisher(results: dict[int, dict[str, Any]]) -> str:
    database = FakeDatabase()
    database["flow_projects"].docs.append(
        {"flow_id": "flow-b", "user_id": "user_b", "nodes": [{"id": "node-b"}], "edges": []}
    )
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-b",
            "flow_run_id": "run-b",
            "flow_id": "flow-b",
            "status": "running",
            "trace_id": "trace-b",
            "protocol_version": 2,
            "user_id": "user_b",
        }
    )
    database["flow_task"].docs.append(
        {
            "flow_task_id": "task-a",
            "flow_run_id": "run-a",
            "flow_id": "flow-a",
            "status": "running",
            "trace_id": "trace-a",
            "protocol_version": 2,
            "user_id": "user_a",
        }
    )
    database["node_results"].docs.append(
        {
            "workflow_id": "flow-b",
            "node_id": "node-1",
            "result_id": "result-1",
            "user_id": "user_b",
            "result": "secret",
            "created_at": datetime.now(UTC),
        }
    )
    client = _publisher_client(database)
    frontend_note = ""

    try:
        blocked = client.get("/api/v2/user/info")
        who = client.get("/api/v2/whoami", headers=_auth("user_a"))
        _require(blocked.status_code == 401, f"无 token 的业务 HTTP 不是 401：{blocked.status_code}")
        _require(blocked.json()["msg"] == "Authorization field is required", blocked.text)
        _require(who.status_code == 200, who.text)
        _require(who.json()["user_id"] == "user_a", f"request.user.user_id={who.json()}")
        frontend_note = (
            f"服务端无 Authorization 的 GET /api/v2/user/info 为 401。"
            f"JWT sub=user_a 时 request.user.user_id={who.json()['user_id']}。"
        )
        _record(results, 1, frontend_note)
    except Exception as exc:
        _fail(results, 1, exc)

    try:
        foreign_flow = client.get("/api/v2/flow/project/flow-b", headers=_auth("user_a"))
        missing_flow = client.get("/api/v2/flow/project/flow-missing", headers=_auth("user_a"))
        foreign_run = client.get("/api/v2/flow/runs/task-b", headers=_auth("user_a"))
        missing_run = client.get("/api/v2/flow/runs/task-missing", headers=_auth("user_a"))
        body = {"workflow_id": "flow-b", "node_ids": ["node-1"], "user_id": "user_b"}
        foreign_result = client.post(
            "/api/v3/result/all_batch_fetch",
            headers=_auth("user_a"),
            json=body,
        )
        missing_result = client.post(
            "/api/v3/result/all_batch_fetch",
            headers=_auth("user_a"),
            json={"workflow_id": "flow-missing", "node_ids": ["node-1"], "user_id": "user_b"},
        )
        patched = client.patch(
            "/api/v3/result",
            headers=_auth("user_a"),
            json={
                "flow_id": "flow-b",
                "node_id": "node-1",
                "result_id": "result-1",
                "result": "changed",
                "user_id": "user_b",
            },
        )
        before_create = len(database["flow_task"].docs)
        created = client.post(
            "/api/v2/flow/runs",
            headers=_auth("user_a"),
            json={
                "client_request_id": "req-1",
                "flow_id": "flow-1",
                "flow_task": {"nodes": [{"id": "n"}], "edges": []},
                "user_id": "user_b",
            },
        )
        result_queries = [
            query
            for query in database["node_results"].queries
            if query.get("workflow_id") == "flow-b" and "node_id" in query
        ]
        update_queries = [
            query
            for query in database["node_results"].queries
            if query.get("result_id") == "result-1"
        ]
        _require(foreign_flow.status_code == missing_flow.status_code == 404, "flow 读取没有和缺失项对齐")
        _require(foreign_flow.json() == missing_flow.json(), "别人的 flow 响应和缺失项不同")
        _require(foreign_run.status_code == missing_run.status_code == 404, "run 读取没有和缺失项对齐")
        _require(foreign_run.json() == missing_run.json(), "别人的 run 响应和缺失项不同")
        _require(foreign_result.json()["data"] == missing_result.json()["data"] == {"node-1": []}, "别人的结果不是空")
        _require(result_queries and all(query.get("user_id") == "user_a" for query in result_queries), "结果查询没用 JWT sub")
        _require(update_queries and update_queries[-1].get("user_id") == "user_a", "更新查询跟了请求体 user_id")
        _require(patched.status_code == 404, f"越权更新不是 404：{patched.status_code}")
        _require(database["node_results"].docs[0]["result"] == "secret", "越权更新改写了结果")
        _require(created.status_code == 422, f"请求体 user_id 没有被拒绝：{created.status_code}")
        _require(len(database["flow_task"].docs) == before_create, "请求体 user_id 写入了 run")
        _record(
            results,
            2,
            "user_a 读 user_b 的 flow、run、结果，状态和响应与不存在相同。"
            "结果查询和更新条件里的 user_id 是 user_a。创建 run 的请求体 user_id=user_b 得到 422，没有新文档。",
        )
    except Exception as exc:
        _fail(results, 2, exc)

    try:
        with client.websocket_connect("/api/v2/flow/runs/task-b/events/conn-1") as websocket:
            websocket.send_json({"event_type": "ping", "protocol_version": 2})
            first = websocket.receive_json()
            try:
                websocket.receive_json()
                raise AssertionError("首包不是 auth 时连接没有关闭")
            except WebSocketDisconnect as caught:
                not_auth = caught.code
        _require(first["code"] == "AUTH_REQUIRED", first)
        _require(not_auth == 4401, f"首包不是 auth 的关闭码是 {not_auth}")

        with client.websocket_connect("/api/v2/flow/runs/task-b/events/conn-2") as websocket:
            websocket.send_json(
                {"event_type": "auth", "protocol_version": 2, "token": _token("user_a")}
            )
            foreign = websocket.receive_json()
            try:
                websocket.receive_json()
                raise AssertionError("别人的 run 没有关闭")
            except WebSocketDisconnect as caught:
                foreign_code = caught.code
        _require(foreign["code"] == "RUN_NOT_FOUND", foreign)
        _require(foreign.get("event_type") != "authenticated", "归属确认前就回了 authenticated")
        _require(foreign_code == 4404, f"别人的 run 关闭码是 {foreign_code}")

        with client.websocket_connect("/api/v2/flow/runs/task-a/events/conn-3") as websocket:
            websocket.send_json(
                {"event_type": "auth", "protocol_version": 2, "token": _token("user_a")}
            )
            authenticated = websocket.receive_json()
            websocket.send_json({"event_type": "ping", "protocol_version": 2})
            rejected = websocket.receive_json()
            try:
                websocket.receive_json()
                raise AssertionError("下一条不是 attach_flow 时连接没有关闭")
            except WebSocketDisconnect as caught:
                attach_code = caught.code
        _require(authenticated["event_type"] == "authenticated", authenticated)
        _require(rejected["code"] == "ATTACH_REQUIRED", rejected)
        _require(attach_code == 4400, f"下一条不是 attach_flow 的关闭码是 {attach_code}")
        _record(
            results,
            3,
            "首包 ping 关闭 4401。user_a 的 auth 打在 user_b 的 task-b 上，先收到 RUN_NOT_FOUND 再关闭 4404。"
            "user_a 自己的 task-a 先收到 authenticated，下一条 ping 关闭 4400。",
        )
    except Exception as exc:
        _fail(results, 3, exc)

    try:
        settings = get_settings()
        previous_key = settings.internal_api_key
        settings.internal_api_key = "internal-secret"
        database["flow_projects"].docs[0]["nodes"] = [{"id": "original"}]
        queries_before = len(database["flow_projects"].queries)
        digest_calls: list[tuple[str, str]] = []
        real_digest = secrets.compare_digest

        def _wrapped_digest(left: str, right: str) -> bool:
            digest_calls.append((left, right))
            return real_digest(left, right)

        secrets.compare_digest = _wrapped_digest  # type: ignore[method-assign]
        try:
            missing_key = client.post(
                "/api/internal/workflow/edit",
                json={"user_id": "user_b", "flow_id": "flow-b", "nodes": [{"id": "stolen"}], "edges": []},
            )
            user_jwt = client.post(
                "/api/internal/workflow/edit",
                headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"},
                json={"user_id": "user_a", "flow_id": "flow-b", "nodes": [{"id": "stolen"}], "edges": []},
            )
            wrong_key = client.post(
                "/api/internal/workflow/edit",
                headers=_service_key("wrong-secret"),
                json={"user_id": "user_b", "flow_id": "flow-b", "nodes": [{"id": "stolen"}], "edges": []},
            )
            edited = client.post(
                "/api/internal/workflow/edit",
                headers=_service_key("internal-secret"),
                json={"user_id": "user_b", "flow_id": "flow-b", "nodes": [{"id": "edited"}], "edges": []},
            )
            other_owner = client.post(
                "/api/internal/workflow/edit",
                headers=_service_key("internal-secret"),
                json={"user_id": "user_a", "flow_id": "flow-b", "nodes": [{"id": "stolen"}], "edges": []},
            )
            settings.internal_api_key = ""
            unconfigured = client.post(
                "/api/internal/workflow/edit",
                headers=_service_key("internal-secret"),
                json={"user_id": "user_b", "flow_id": "flow-b", "nodes": [{"id": "stolen"}], "edges": []},
            )
        finally:
            secrets.compare_digest = real_digest  # type: ignore[method-assign]
            settings.internal_api_key = previous_key

        project = database["flow_projects"].docs[0]
        update_queries = [
            query
            for query in database["flow_projects"].queries[queries_before:]
            if query.get("flow_id") == "flow-b" and "user_id" in query
        ]
        _require(missing_key.status_code == 401, f"无密钥不是 401：{missing_key.status_code}")
        _require(wrong_key.status_code == 401, f"错误密钥不是 401：{wrong_key.status_code}")
        _require(user_jwt.status_code == 401, f"用户 JWT 不是 401：{user_jwt.status_code}")
        _require(unconfigured.status_code == 503, f"未配置密钥不是 503：{unconfigured.status_code}")
        _require(edited.status_code == 200, edited.text)
        _require(project["nodes"] == [{"id": "edited"}], project["nodes"])
        _require(project["user_id"] == "user_b", "编辑改写了资源主人")
        _require(other_owner.status_code == 200, other_owner.text)
        _require(project["nodes"] == [{"id": "edited"}], "请求体里另一个 user_id 改写了项目")
        _require(
            [query["user_id"] for query in update_queries] == ["user_b", "user_a"],
            f"更新条件不是请求体 user_id：{update_queries}",
        )
        _require(any(left == "wrong-secret" for left, _right in digest_calls), "错误密钥没有走 compare_digest")
        _require(any(left == "internal-secret" for left, _right in digest_calls), "正确密钥没有走 compare_digest")
        _record(
            results,
            5,
            "无密钥、错误密钥、用户 JWT 都是 401，密钥未配置是 503，比对走 compare_digest。"
            "密钥通过后，body user_id=user_b 更新了 user_b 的项目；body user_id=user_a 的更新条件对不上，节点保持 edited。",
        )
    except Exception as exc:
        _fail(results, 5, exc)

    return frontend_note


class _ConsumerSwap:
    def __enter__(self) -> Any:
        publisher_root = str(ROOT / "novelcomic-publisher")
        consumer_root = str(ROOT / "novelcomic-consumer")
        self.stashed = {
            key: sys.modules.pop(key)
            for key in list(sys.modules)
            if key == "app" or key.startswith("app.")
        }
        sys.path[:] = [item for item in sys.path if item != publisher_root]
        sys.path.insert(0, consumer_root)
        import app.config as consumer_config
        import app.controller.internal as internal_api
        import app.controller.internal.auth as internal_auth
        import app.main as consumer_main

        self.modules = {
            "auth": internal_auth,
            "config": consumer_config,
            "internal": internal_api,
            "main": consumer_main,
        }
        return self.modules

    def __exit__(self, *_exc: object) -> None:
        consumer_root = str(ROOT / "novelcomic-consumer")
        publisher_root = str(ROOT / "novelcomic-publisher")
        for key in list(sys.modules):
            if key == "app" or key.startswith("app."):
                sys.modules.pop(key, None)
        sys.path[:] = [item for item in sys.path if item != consumer_root]
        sys.modules.update(self.stashed)
        if publisher_root not in sys.path:
            sys.path.insert(0, publisher_root)


def _callback_body() -> bytes:
    return json.dumps(
        {
            "ai_task_id": "task-hmac-1",
            "status": "success",
            "model_id": "novelcomic-image",
            "error": None,
            "started_at": "2026-09-28T13:00:00.000Z",
            "completed_at": "2026-09-28T13:00:03.000Z",
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()


class _CallbackCollection:
    async def find_one(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def find_one_and_update(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def update_one(self, *_args: Any, **_kwargs: Any) -> UpdateResult:
        return UpdateResult(0)


class _CallbackDatabase:
    def __getitem__(self, _name: str) -> _CallbackCollection:
        return _CallbackCollection()


def _run_consumer(results: dict[int, dict[str, Any]]) -> None:
    with _ConsumerSwap() as modules:
        settings = modules["config"].get_settings()
        previous_key = settings.internal_api_key
        previous_secret = settings.consumer_webhook_secret
        previous_window = settings.consumer_webhook_timestamp_tolerance_seconds
        try:
            _run_snapshot(results, modules, settings)
            _run_callback(results, modules, settings)
        finally:
            settings.internal_api_key = previous_key
            settings.consumer_webhook_secret = previous_secret
            settings.consumer_webhook_timestamp_tolerance_seconds = previous_window


def _snapshot_app(modules: dict[str, Any], database: FakeDatabase) -> TestClient:
    settings = modules["config"].get_settings()
    app = FastAPI()
    modules["internal"].register_internal_api(app)
    app.state.connections = SimpleNamespace(
        mongo={settings.mongo_database: database},
        redis=None,
    )
    return TestClient(app)


def _seed_snapshot(database: FakeDatabase) -> None:
    database["flow_task"].docs.append({"flow_task_id": "task-1", "status": "queued"})
    database["flow_run_state"].docs.append(
        {
            "flow_run_id": "run-1",
            "flow_task_id": "task-1",
            "status": "running",
            "updated_at": datetime.now(UTC),
        }
    )
    database["flow_node_state"].docs.append(
        {"node_id": "model", "run_id": "run-1", "status": "running"}
    )
    database["flow_event_outbox"].docs.append(
        {
            "event_id": "evt-1",
            "flow_task_id": "task-1",
            "status": "sent",
            "created_at": datetime.now(UTC),
        }
    )


def _run_snapshot(results: dict[int, dict[str, Any]], modules: dict[str, Any], settings: Any) -> None:
    try:
        settings.internal_api_key = "internal-secret"
        database = FakeDatabase()
        _seed_snapshot(database)
        client = _snapshot_app(modules, database)
        path = "/api/internal/workflow/task-1/snapshot"
        digest_calls: list[tuple[str, str]] = []
        real_digest = modules["auth"].secrets.compare_digest

        def _wrapped_digest(left: str, right: str) -> bool:
            digest_calls.append((left, right))
            return real_digest(left, right)

        modules["auth"].secrets.compare_digest = _wrapped_digest
        try:
            missing = client.get(path)
            wrong = client.get(path, headers=_service_key("wrong-secret"))
            user_jwt = client.get(path, headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"})
            found = client.get(path, headers=_service_key("internal-secret"))
            settings.internal_api_key = ""
            unconfigured = client.get(path, headers=_service_key("internal-secret"))
        finally:
            modules["auth"].secrets.compare_digest = real_digest

        _require(missing.status_code == 401, f"无密钥不是 401：{missing.status_code} {missing.text}")
        _require(wrong.status_code == 401, f"错误密钥不是 401：{wrong.status_code}")
        _require(user_jwt.status_code == 401, f"用户 JWT 不是 401：{user_jwt.status_code}")
        _require(unconfigured.status_code == 503, f"未配置不是 503：{unconfigured.status_code} {unconfigured.text}")
        _require(found.status_code == 200, found.text)
        _require(found.json()["protocol_version"] == 2, found.text)
        _require(found.json()["flow_task_id"] == "task-1", found.text)
        _require(any(pair[0] == "wrong-secret" for pair in digest_calls), "错误密钥没有调用 compare_digest")
        _require(any(pair == ("internal-secret", "internal-secret") for pair in digest_calls), "正确密钥没有调用 compare_digest")
        _record(
            results,
            4,
            "snapshot 无密钥 401，错误密钥 401，用户 JWT 401，密钥未配置 503。"
            "正确密钥返回 protocol_version=2。错误密钥和正确密钥都经过 secrets.compare_digest。",
        )
    except Exception as exc:
        _fail(results, 4, exc)


def _post_callback(app: FastAPI, content: bytes, headers: dict[str, str]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async def _send() -> httpx.Response:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post("/callbacks/models/opencreator_ai", content=content, headers=headers)

    return asyncio.run(_send())


def _run_callback(results: dict[int, dict[str, Any]], modules: dict[str, Any], settings: Any) -> None:
    try:
        secret = "callback-secret"
        settings.consumer_webhook_secret = secret
        settings.consumer_webhook_timestamp_tolerance_seconds = 300
        raw_body = _callback_body()
        now = datetime.now(UTC).isoformat()
        stale = (datetime.now(UTC) - timedelta(seconds=301)).isoformat()
        tampered = bytearray(raw_body)
        tampered[10] = tampered[10] ^ 0x01
        app = modules["main"].create_app()
        app.router.lifespan_context = _skip_lifespan
        app.state.connections = SimpleNamespace(
            mongo={settings.mongo_database: _CallbackDatabase()},
            redis=None,
        )
        digest_calls: list[tuple[str, str]] = []
        real_digest = modules["main"].hmac.compare_digest

        def _wrapped_digest(left: str, right: str) -> bool:
            digest_calls.append((str(left), str(right)))
            return real_digest(left, right)

        modules["main"].hmac.compare_digest = _wrapped_digest
        try:
            changed = _post_callback(
                app,
                bytes(tampered),
                {
                    "content-type": "application/json",
                    "x-oc-idempotency-key": "idem-changed",
                    "x-oc-signature": _signature(secret, now, raw_body),
                    "x-oc-timestamp": now,
                },
            )
            compared_for_body = len(digest_calls)
            outside = _post_callback(
                app,
                raw_body,
                {
                    "content-type": "application/json",
                    "x-oc-idempotency-key": "idem-stale",
                    "x-oc-signature": _signature(secret, stale, raw_body),
                    "x-oc-timestamp": stale,
                },
            )
            settings.consumer_webhook_secret = ""
            before_unverified = len(digest_calls)
            unverified = _post_callback(
                app,
                raw_body,
                {
                    "content-type": "application/json",
                    "x-oc-idempotency-key": "idem-unverified",
                    "x-oc-signature": "0" * 64,
                    "x-oc-timestamp": stale,
                },
            )
        finally:
            modules["main"].hmac.compare_digest = real_digest

        _require(changed.status_code == 401, f"改一个字节不是 401：{changed.status_code} {changed.text}")
        _require(changed.json()["status"] == "invalid_signature", changed.text)
        _require(compared_for_body == 1, "改一个字节的 body 没有走 hmac.compare_digest")
        _require(outside.status_code == 401, f"时间窗外不是 401：{outside.status_code} {outside.text}")
        _require(outside.json()["status"] == "invalid_signature", outside.text)
        _require(unverified.status_code == 200, f"未配置密钥没有放行：{unverified.status_code} {unverified.text}")
        _require(unverified.json()["status"] == "accepted", unverified.text)
        _require(len(digest_calls) == before_unverified, "密钥未配置时仍然验了签")
        _record(
            results,
            7,
            "回调 body 改一个字节，hmac.compare_digest 失败后 401 invalid_signature。"
            "时间窗外的 x-oc-timestamp 为 401。CONSUMER_WEBHOOK_SECRET 为空时错误签名和时间窗外的请求进入后续解析，状态 accepted，这次没有调用 compare_digest，记成未验签放行。",
        )
    except Exception as exc:
        _fail(results, 7, exc)


class _AgentCursor:
    def sort(self, *_args: Any, **_kwargs: Any) -> _AgentCursor:
        return self

    def limit(self, *_args: Any, **_kwargs: Any) -> _AgentCursor:
        return self

    def __aiter__(self) -> _AgentCursor:
        return self

    async def __anext__(self) -> dict[str, Any]:
        raise StopAsyncIteration


class _AgentCollection:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.docs = docs or []

    async def find_one(self, query: dict[str, Any], *_args: Any, **_kwargs: Any) -> dict[str, Any] | None:
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    def find(self, _query: dict[str, Any]) -> _AgentCursor:
        return _AgentCursor()


class _AgentDatabase:
    def __init__(self) -> None:
        self.collections = {
            "agent_sessions": _AgentCollection(
                [
                    {
                        "_id": "session-b",
                        "session_id": "session-b",
                        "user_id": "user-b",
                        "channel": "api",
                        "message_count": 0,
                        "turn_count": 0,
                        "status": "idle",
                        "revision": 0,
                        "last_seq": 0,
                    }
                ]
            )
        }

    def __getitem__(self, name: str) -> _AgentCollection:
        if name not in self.collections:
            self.collections[name] = _AgentCollection()
        return self.collections[name]


class _AgentRedis:
    def __init__(self) -> None:
        self.meta = {
            "run-b": {"user_id": "user-b"},
            "run-a": {"user_id": "user-a", "session_id": "session-a"},
        }

    async def get(self, _key: str) -> None:
        return None

    async def hgetall(self, key: str) -> dict[str, str]:
        for run_id, meta in self.meta.items():
            if f":{run_id}:" in f":{key}:":
                return meta
        return {}

    async def set(self, _key: str, _value: str, ex: int | None = None) -> None:
        del ex
        return None


class _RecordingFlows:
    def __init__(self) -> None:
        self.queries: list[dict[str, str]] = []
        self.docs = [{"flow_id": "flow-1", "user_id": "user-a", "nodes": [], "edges": []}]

    async def find_one(self, query: dict[str, str], projection: dict[str, int]) -> dict[str, Any] | None:
        del projection
        self.queries.append(dict(query))
        for document in self.docs:
            if all(document.get(key) == value for key, value in query.items()):
                return document
        return None


def _fake_resolve(mapping: dict[str, list[str]]):
    def _resolver(hostname: str, _port: int | None = None, _family: int = 0, _type: int = 0):
        addresses = mapping.get(hostname)
        if addresses is None:
            raise socket.gaierror(f"cannot resolve {hostname}")
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 0)) for ip in addresses]

    return _resolver


def _run_agent(results: dict[int, dict[str, Any]]) -> None:
    sys.path.insert(0, str(ROOT / "novelcomic-agent" / "src"))
    from novelcomic_agent.api.server import create_agent_router
    from novelcomic_agent.config import Settings
    from novelcomic_agent.core.tools.run_workflow import RunWorkflowTool
    from novelcomic_agent.core.tools.web import WebFetchTool
    from novelcomic_agent.dao.workflow_dao import WorkflowDAO
    from novelcomic_agent.providers.remote_image import download_remote_image
    from novelcomic_agent.security import network

    settings = Settings(clerk_pem_public_key=_PUBLIC_PEM, public_chat_user_id="")
    app = FastAPI()
    app.include_router(create_agent_router(settings))
    app.state.dependencies = SimpleNamespace(
        redis=_AgentRedis(),
        mongo={settings.mongodb_database: _AgentDatabase()},
    )

    try:
        with TestClient(app) as client:
            invalid = client.get(
                "/v1/agent/sessions",
                headers={"Authorization": "Bearer not-a-jwt"},
            )
            missing = client.get("/v1/agent/sessions")
            foreign_run = client.post(
                "/v1/agent/runs/run-b/cancel",
                headers={"Authorization": f"Bearer {_token('user-a')}", "X-User-Id": "user-b"},
            )
            owned_run = client.post(
                "/v1/agent/runs/run-a/cancel",
                headers={"Authorization": f"Bearer {_token('user-a')}", "X-User-Id": "user-b"},
            )
            foreign_session = client.get(
                "/v1/agent/sessions/session-b/messages",
                headers={"Authorization": f"Bearer {_token('user-a')}"},
            )
        _require(invalid.status_code == 401, f"非法 JWT 不是 401：{invalid.status_code} {invalid.text}")
        _require(invalid.json()["detail"]["code"] == "UNAUTHENTICATED", invalid.text)
        _require(missing.status_code == 401, f"无 Bearer 不是 401：{missing.status_code}")
        _require(foreign_run.status_code == 403, f"别人的 run 不是 403：{foreign_run.status_code} {foreign_run.text}")
        _require(foreign_run.json()["detail"]["code"] == "RUN_FORBIDDEN", foreign_run.text)
        _require(owned_run.status_code == 200, f"sub 名下的 run 被 X-User-Id 带偏：{owned_run.status_code} {owned_run.text}")
        _require(foreign_session.status_code == 403, f"别人的 session 不是 403：{foreign_session.status_code} {foreign_session.text}")
        _record(
            results,
            8,
            "Bearer not-a-jwt 为 401 UNAUTHENTICATED。public_chat_user_id 为空时，无 Bearer 为 401。"
            "user-a 的 JWT 加 X-User-Id=user-b 取消 run-b 为 403；同一头取消自己的 run-a 为 200，user_id 来自 sub。"
            "读取 user-b 的 session-b 为 403。",
        )
    except Exception as exc:
        _fail(results, 8, exc)

    try:
        flows = _RecordingFlows()
        dao = WorkflowDAO(flows)

        async def _query() -> None:
            found = await dao.get_workflow("flow-1", "user-a")
            missing_flow = await dao.get_workflow("flow-1", "user-b")
            tool = RunWorkflowTool(WorkflowDAO(flows))
            missing_user = await tool.execute({}, {"flow_id": "flow-1"})
            ready = await tool.execute({}, {"user_id": "user-a", "flow_id": "flow-1"})
            _require(found is not None and found["user_id"] == "user-a", "认证用户没有读到自己的 flow")
            _require(missing_flow is None, "别的 user_id 读到了 flow")
            _require(str(missing_user).startswith("Error: no authenticated user"), missing_user)
            _require(ready == "Workflow flow-1 is ready.", ready)

        asyncio.run(_query())
        _require(
            flows.queries == [
                {"flow_id": "flow-1", "user_id": "user-a"},
                {"flow_id": "flow-1", "user_id": "user-b"},
                {"flow_id": "flow-1", "user_id": "user-a"},
            ],
            f"flow 查询条件不对：{flows.queries}",
        )
        _record(
            results,
            9,
            "WorkflowDAO.get_workflow 的条件是 flow_id 加认证 user_id。user-b 读不到 user-a 的 flow。"
            "RunWorkflowTool 在没有认证 user_id 时返回错误；有 user-a 时查询条件仍带 user_id=user-a。",
        )
    except Exception as exc:
        _fail(results, 9, exc)

    try:
        mapping = {
            "127.0.0.1": ["127.0.0.1"],
            "169.254.169.254": ["169.254.169.254"],
            "10.0.0.8": ["10.0.0.8"],
            "example.com": ["93.184.216.34"],
        }
        calls: list[str] = []

        def _reject_if_called(url: str) -> str:
            raise AssertionError(f"连接前没有拒绝 {url}")

        def _redirect(url: str) -> SimpleNamespace:
            calls.append(url)
            return SimpleNamespace(url="http://10.0.0.8/secret", text="internal-body", content=b"internal-body")

        def _public(url: str) -> str:
            calls.append(url)
            return "public page"

        original = network.socket.getaddrinfo
        network.socket.getaddrinfo = _fake_resolve(mapping)  # type: ignore[method-assign]
        try:
            blocked = [
                asyncio.run(WebFetchTool(_reject_if_called).execute(url=url))
                for url in (
                    "http://127.0.0.1/admin",
                    "http://169.254.169.254/latest/meta-data",
                    "http://10.0.0.8/secret",
                )
            ]
            image_blocked = download_remote_image(
                "http://169.254.169.254/latest/meta-data",
                _reject_if_called,
            )
            redirected = asyncio.run(WebFetchTool(_redirect).execute(url="https://example.com/start"))
            image_redirect = download_remote_image("https://example.com/image.png", _redirect)
            public = asyncio.run(WebFetchTool(_public).execute(url="https://example.com/page"))
        finally:
            network.socket.getaddrinfo = original  # type: ignore[method-assign]

        _require(all(str(item).startswith("Error: URL validation failed:") for item in blocked), blocked)
        _require(image_blocked is None, "元数据地址的图片下载没有在连接前停下")
        _require(str(redirected).startswith("Error: Redirect blocked:"), redirected)
        _require("internal-body" not in str(redirected), "重定向到内网后仍然返回了 body")
        _require(image_redirect is None, "重定向到内网的图片 body 被留下了")
        _require(public == "public page", public)
        _require(calls[0] == "https://example.com/start", calls)
        _record(
            results,
            10,
            "127.0.0.1、169.254.169.254、10.0.0.8 在 web_fetch 连接前被拒绝，抓取函数没有被调用。"
            "example.com 第一次校验通过并完成连接，最终 URL 10.0.0.8 被第二次拒绝，响应 body 没有返回。"
            "远程图片走同一套两次校验。公网 example.com/page 仍能抓到正文。",
        )
    except Exception as exc:
        _fail(results, 10, exc)


def _start_node(kind: str, report: Path) -> subprocess.Popen[str]:
    env = os.environ.copy()
    if kind == "ai":
        env["ACCEPT_AI_REPORT"] = str(report)
        command = [
            str(ROOT / "novelcomic-ai" / "node_modules" / ".bin" / "vitest"),
            "run",
            "apps/api/src/accept-security-tenant-internal-auth.test.ts",
        ]
        cwd = ROOT / "novelcomic-ai"
    else:
        env["ACCEPT_FRONTEND_REPORT"] = str(report)
        command = [
            str(ROOT / "novelcomic-frontend" / "node_modules" / ".bin" / "vitest"),
            "run",
            "src/api/accept-security-tenant-internal-auth.test.ts",
        ]
        cwd = ROOT / "novelcomic-frontend"
    return subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _finish_node(kind: str, process: subprocess.Popen[str], report: Path) -> dict[str, str]:
    stdout, stderr = process.communicate()
    if process.returncode != 0 or not report.exists():
        tail = (stdout + "\n" + stderr)[-1500:]
        return {kind: f"{kind} 验收没有通过：{tail}"}
    payload = json.loads(report.read_text(encoding="utf-8"))
    return {str(key): str(value) for key, value in payload.items()}


def main() -> int:
    ai_report = Path(tempfile.mkstemp(prefix="accept-security-ai-", suffix=".json")[1])
    frontend_report = Path(tempfile.mkstemp(prefix="accept-security-fe-", suffix=".json")[1])
    ai_proc = _start_node("ai", ai_report)
    frontend_proc = _start_node("frontend", frontend_report)
    results: dict[int, dict[str, Any]] = {}
    try:
        _run_publisher(results)
        _run_consumer(results)
        _run_agent(results)
    except Exception as exc:
        for step in range(1, 11):
            results.setdefault(
                step,
                {"step": step, "name": _STEP_TITLES[step - 1], "ok": False, "detail": _format_error(exc)},
            )
    node = {
        **_finish_node("ai", ai_proc, ai_report),
        **_finish_node("frontend", frontend_proc, frontend_report),
    }
    ai_report.unlink(missing_ok=True)
    frontend_report.unlink(missing_ok=True)

    frontend_detail = node.get("1") or node.get("frontend") or "没有拿到前端验收输出"
    frontend_ok = "1" in node and not frontend_detail.startswith("frontend 验收没有通过")
    backend = results.get(1)
    if backend and backend["ok"] and frontend_ok:
        backend["detail"] = f"{frontend_detail} {backend['detail']}"
    elif backend and backend["ok"]:
        backend["ok"] = False
        backend["detail"] = frontend_detail
    elif frontend_ok and backend:
        backend["detail"] = f"{frontend_detail} 服务端这一半没有通过：{backend['detail']}"

    ai_detail = node.get("6") or node.get("ai") or "没有拿到 AI 验收输出"
    ai_ok = "6" in node and not str(ai_detail).startswith("ai 验收没有通过")
    results[6] = {
        "step": 6,
        "name": _STEP_TITLES[5],
        "ok": ai_ok,
        "detail": ai_detail,
    }

    passed = 0
    print("安全租户与内部鉴权验收")
    print()
    for step in range(1, 11):
        item = results.get(step) or {
            "ok": False,
            "name": _STEP_TITLES[step - 1],
            "detail": "没有跑到",
        }
        if item["ok"]:
            passed += 1
        mark = "PASS" if item["ok"] else "FAIL"
        print(f"{mark} {step:02d} {item['name']}")
        print(f"    {item['detail']}")
    print()
    print(f"勾选 {passed}/10。")
    print(_OUT_OF_SCOPE)
    return 0 if passed == 10 else 1


if __name__ == "__main__":
    raise SystemExit(main())
