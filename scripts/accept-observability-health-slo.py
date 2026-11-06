#!/usr/bin/env python3
"""按观测告警健康与 SLO 的 16 条验收顺序打证据。

用法：
  novelcomic-publisher/.venv/bin/python scripts/accept-observability-health-slo.py
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
_VENV_PYTHON = ROOT / "novelcomic-publisher" / ".venv" / "bin" / "python"
if _VENV_PYTHON.exists() and Path(sys.executable).resolve() != _VENV_PYTHON.resolve():
    if os.environ.get("NOVELCOMIC_ACCEPT_OBS_PY") != "1":
        os.environ["NOVELCOMIC_ACCEPT_OBS_PY"] = "1"
        os.execv(_VENV_PYTHON, [str(_VENV_PYTHON), *sys.argv])

sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pymongo.errors import DuplicateKeyError  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.common.context.request_context import RequestContext  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.controller import health as publisher_health  # noqa: E402
from app.controller.v2 import flow_runs as flow_runs_api  # noqa: E402
from app.core.sentry import (  # noqa: E402
    before_send as publisher_before_send,
)
from app.core.sentry import (  # noqa: E402
    before_send_transaction as publisher_before_send_transaction,
)
from app.core.sentry import (  # noqa: E402
    init_sentry as publisher_init_sentry,
)
from app.core.sentry import (  # noqa: E402
    traces_sampler as publisher_traces_sampler,
)
from app.main import create_app  # noqa: E402

TRACE_ID = re.compile(r"^1-[0-9a-f]{8}-[0-9a-f]{24}$")
_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_STEP_TITLES = [
    "POST /api/v2/flow/runs 的 X-Trace-ID 和 body trace_id 都在，而且可以不同",
    "入站自己带的 X-Trace-ID 不会变成响应头",
    "Mongo 的 flow_task.trace_id、命令、run_flow 消息三者相同",
    "continue 复用创建时那张",
    "事件 WebSocket accept 后的 RequestContext 是另一张，命令上的 run ID 不变",
    "Consumer 日志能用 run 这张搜到；空上下文打印 N/A",
    "有 publish_timestamp 时打出 flow.queue_delay，比较的是 publish 到 run_flow 入口",
    "回调入口不会带上一条请求的 trace_id",
    "Sentry DSN 为空时服务能启动。健康检查不采样。预期业务异常不进 issue",
    "Publisher /readyz 看维护文件和 active_ws",
    "Consumer 阈值保持 0 时，积压不导致 /readyz 503；DRAINING 会 503。body 里有 flow_engine",
    "Publisher /health/consumer 只打两边的 /health。一边失败时它 503，Publisher /readyz 仍按自己的规则",
    "AI：Mongo 和 Redis 通、worker 心跳缺失时 /readyz 为 200，body 带心跳字段",
    "飞书 HTTP 失败或 code!=0 时，callback 终态和模型任务状态保持原路径",
    "Agent 公开 /health 回 ok。非本机调用 /preview/drain 为 404",
    "前端无 DSN、无 PostHog key 时主路径可用。连接 exhausted 有断线提示",
]
FLOW_TASK = {
    "nodes": [{"id": "n", "type": "textInput", "data": {"text": "一只猫"}}],
    "edges": [],
}


class UpdateResult:
    def __init__(self, matched_count: int) -> None:
        self.matched_count = matched_count
        self.modified_count = matched_count


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

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
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                if "$lte" in expected and (actual is None or actual > expected["$lte"]):
                    return False
                if "$lt" in expected and (actual is None or actual >= expected["$lt"]):
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
    def _apply(document: dict[str, Any], update: dict[str, Any]) -> None:
        document.update(copy.deepcopy(update.get("$set", {})))
        for key, value in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + value
        for key in update.get("$unset", {}):
            document.pop(key, None)

    async def insert_one(self, document: dict[str, Any], **_kwargs: Any) -> None:
        next_doc = copy.deepcopy(document)
        next_doc.setdefault("_id", f"fake-{len(self.docs) + 1}")
        for existing in self.docs:
            if (
                existing.get("user_id") == next_doc.get("user_id")
                and existing.get("command_id") == next_doc.get("command_id")
                and next_doc.get("command_id")
            ):
                raise DuplicateKeyError("duplicate")
        self.docs.append(next_doc)

    async def find_one(self, query: dict[str, Any], *_args: Any, **_kwargs: Any) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return copy.deepcopy(document)
        return None

    async def update_one(self, query: dict[str, Any], update: dict[str, Any], **_kwargs: Any) -> UpdateResult:
        for document in self.docs:
            if self._matches(document, query):
                self._apply(document, update)
                return UpdateResult(1)
        return UpdateResult(0)

    async def delete_one(self, query: dict[str, Any], **_kwargs: Any) -> UpdateResult:
        for index, document in enumerate(self.docs):
            if self._matches(document, query):
                self.docs.pop(index)
                return UpdateResult(1)
        return UpdateResult(0)

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        *,
        sort: Any = None,
        return_document: Any = None,
        upsert: bool = False,
        **_kwargs: Any,
    ) -> dict[str, Any] | None:
        del sort, return_document, upsert
        for document in self.docs:
            if self._matches(document, query):
                self._apply(document, update)
                return copy.deepcopy(document)
        return None

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for document in self.docs if self._matches(document, query))


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeRedis:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def xadd(self, queue_name: str, message: dict[str, Any], *_args: Any, **_kwargs: Any) -> str:
        self.messages.append({"message": copy.deepcopy(message), "queue_name": queue_name})
        return f"{len(self.messages)}-0"


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _token(sub: str) -> str:
    encoded = jwt.encode({"sub": sub, "exp": int(time.time()) + 3600}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def _message_body(message: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(message["payload"])
    _require(isinstance(payload, dict), "run_flow payload 不是对象")
    return payload


def _format_error(exc: Exception) -> str:
    if isinstance(exc, AssertionError):
        return str(exc) or exc.__class__.__name__
    return "".join(traceback.format_exception(exc)).strip()[-1200:]


def _record(results: dict[int, dict[str, Any]], step: int, fn: Any) -> None:
    name = _STEP_TITLES[step - 1]
    try:
        detail = fn()
        results[step] = {"step": step, "name": name, "ok": True, "detail": detail or "ok"}
    except Exception as exc:
        results[step] = {"step": step, "name": name, "ok": False, "detail": _format_error(exc)}


class _ProbeHandler(BaseHTTPRequestHandler):
    paths: list[tuple[int, str]] = []
    status_code = 200

    def do_GET(self) -> None:  # noqa: N802
        _ProbeHandler.paths.append((self.server.server_address[1], self.path))
        body = b'{"status":"ok","instance_id":"accept"}' if self.status_code == 200 else b'{"status":"down"}'
        self.send_response(self.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        del format, args


def _start_probe(status_code: int) -> ThreadingHTTPServer:
    class Handler(_ProbeHandler):
        pass

    Handler.status_code = status_code
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, name=f"probe-{server.server_address[1]}", daemon=True).start()
    return server


def _publisher_sentry() -> str:
    previous = sys.modules.get("sentry_sdk")

    class BoomSdk:
        @staticmethod
        def init(**_kwargs: Any) -> None:
            raise AssertionError("空 DSN 不应该调用 sentry_sdk.init")

    sys.modules["sentry_sdk"] = BoomSdk()
    try:
        publisher_init_sentry("", "accept")
    finally:
        if previous is None:
            sys.modules.pop("sentry_sdk", None)
        else:
            sys.modules["sentry_sdk"] = previous

    class InsufficientCredits(Exception):
        pass

    _require(publisher_traces_sampler({"transaction_context": {"name": "/health"}}) == 0, "/health 仍被采样")
    _require(publisher_traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0, "/readyz 仍被采样")
    _require(
        publisher_before_send_transaction({"transaction": "/health"}, {}) is None,
        "/health transaction 会送出",
    )
    _require(
        publisher_before_send_transaction({"transaction": "/readyz"}, {}) is None,
        "/readyz transaction 会送出",
    )
    dropped = publisher_before_send(
        {"extra": {"prompt": "secret"}},
        {"exc_info": (InsufficientCredits, InsufficientCredits(), None)},
    )
    _require(dropped is None, "InsufficientCredits 会变成 issue")
    return "Publisher 空 DSN 不初始化。/health 与 /readyz 采样为 0。InsufficientCredits 被 before_send 丢掉。"


def _run_publisher(results: dict[int, dict[str, Any]], sentry_parts: dict[str, str]) -> None:
    database = FakeDatabase()
    redis = FakeRedis()
    settings = get_settings()
    settings.clerk_pem_public_key = _PUBLIC_PEM
    database_name = settings.mongo_database

    @asynccontextmanager
    async def lifespan(app: Any) -> Any:
        app.state.connections = SimpleNamespace(
            mongo={database_name: database},
            redis=redis,
        )
        yield

    app = create_app()
    app.router.lifespan_context = lifespan
    flow_runs_api._WS_AUTH_TIMEOUT_SECONDS = 0.4
    owner = "user_accept_obs"
    headers = {**_auth(owner), "X-Trace-ID": "inbound-trace-should-not-echo"}
    created: dict[str, Any] = {}

    blue = _start_probe(500)
    green = _start_probe(200)
    previous_blue = settings.consumer_blue_url
    previous_green = settings.consumer_green_url
    previous_maintenance = publisher_health.PUBLISHER_MAINTENANCE_PATH
    previous_sockets = dict(flow_runs_api._workflow_sockets)
    maintenance = Path(tempfile.mkdtemp(prefix="accept-obs-")) / "publisher_maintenance"
    try:
        settings.consumer_blue_url = f"http://127.0.0.1:{blue.server_address[1]}"
        settings.consumer_green_url = f"http://127.0.0.1:{green.server_address[1]}"
        publisher_health.PUBLISHER_MAINTENANCE_PATH = str(maintenance)
        with TestClient(app) as client:

            def create_and_compare() -> str:
                response = client.post(
                    "/api/v2/flow/runs",
                    headers=headers,
                    json={
                        "client_request_id": "accept-obs-create",
                        "command_id": "accept-obs-create",
                        "flow_id": "flow-accept",
                        "flow_task": FLOW_TASK,
                    },
                )
                _require(response.status_code == 202, f"创建没有返回 202：{response.status_code} {response.text}")
                header_trace = response.headers.get("X-Trace-ID")
                body = response.json()["data"]
                body_trace = body.get("trace_id")
                _require(bool(header_trace) and TRACE_ID.fullmatch(header_trace or ""), f"响应头 trace 不合格：{header_trace}")
                _require(bool(body_trace) and TRACE_ID.fullmatch(body_trace or ""), f"body trace 不合格：{body_trace}")
                _require(header_trace != body_trace, "响应头和 body 用了同一张 trace")
                _require(header_trace != "inbound-trace-should-not-echo", "入站 X-Trace-ID 被写回了响应头")
                _require(body_trace != "inbound-trace-should-not-echo", "入站 X-Trace-ID 被写成了 run trace")
                run = next(document for document in database["flow_task"].docs if document["user_id"] == owner)
                command = next(
                    document
                    for document in database["workflow_command"].docs
                    if document["command_id"] == "accept-obs-create"
                )
                published = _message_body(redis.messages[0]["message"])
                _require(redis.messages[0]["queue_name"] == "run_flow", "消息没有进 run_flow")
                _require(run["trace_id"] == body_trace, "flow_task.trace_id 和 body 不同")
                _require(command["trace_id"] == body_trace, "命令 trace_id 和 body 不同")
                _require(published["trace_id"] == body_trace, "run_flow 消息 trace_id 和 body 不同")
                _require(published["trace_id"] == redis.messages[0]["message"]["trace_id"], "消息字段和 payload 的 trace 不同")
                created.update(
                    {
                        "body_trace": body_trace,
                        "flow_run_id": body["flow_run_id"],
                        "flow_task_id": body["flow_task_id"],
                        "header_trace": header_trace,
                        "publish_timestamp": published["publish_timestamp"],
                    }
                )
                return f"X-Trace-ID={header_trace} body.trace_id={body_trace}，两张不同"

            _record(results, 1, create_and_compare)
            if results[1]["ok"]:
                _record(
                    results,
                    2,
                    lambda: f"入站 inbound-trace-should-not-echo，响应头是 {created['header_trace']}",
                )
                _record(
                    results,
                    3,
                    lambda: f"flow_task、workflow_command、run_flow 都是 {created['body_trace']}",
                )
            else:
                for step in (2, 3, 4, 5):
                    results[step] = {
                        "step": step,
                        "name": _STEP_TITLES[step - 1],
                        "ok": False,
                        "detail": "创建请求没有通过，这条没有样本",
                    }

            def continue_run() -> str:
                _require(results.get(1, {}).get("ok"), "没有创建样本")
                matched = False
                for document in database["flow_task"].docs:
                    if document.get("flow_task_id") == created["flow_task_id"]:
                        document["status"] = "waiting_for_selection"
                        matched = True
                _require(matched, "创建后的 flow_task 不在替身库里")
                before = len(redis.messages)
                response = client.post(
                    f"/api/v2/flow/runs/{created['flow_task_id']}/continue",
                    headers={**_auth(owner), "X-Trace-ID": "continue-inbound-trace"},
                    json={
                        "command_id": "accept-obs-continue",
                        "flow_run_id": created["flow_run_id"],
                        "flow_task": FLOW_TASK,
                        "user_selection": {"n": {"asset": "chosen"}},
                    },
                )
                _require(response.status_code == 202, f"continue 没有返回 202：{response.status_code} {response.text}")
                _require(response.json()["data"]["trace_id"] == created["body_trace"], "continue 的 body 换了一张 trace")
                _require(response.headers["X-Trace-ID"] != "continue-inbound-trace", "continue 把入站 trace 写回了响应头")
                command = next(
                    document
                    for document in database["workflow_command"].docs
                    if document["command_id"] == "accept-obs-continue"
                )
                published = _message_body(redis.messages[-1]["message"])
                _require(len(redis.messages) == before + 1, "continue 没有再投递一条 run_flow")
                _require(command["trace_id"] == created["body_trace"], "continue 命令没有复用创建时的 trace")
                _require(published["trace_id"] == created["body_trace"], "continue 的 run_flow 没有复用创建时的 trace")
                stored = next(
                    document
                    for document in database["flow_task"].docs
                    if document["flow_task_id"] == created["flow_task_id"]
                )
                _require(stored["trace_id"] == created["body_trace"], "continue 改写了 flow_task.trace_id")
                return f"continue body、命令、run_flow 仍是 {created['body_trace']}"

            if results.get(1, {}).get("ok"):
                _record(results, 4, continue_run)

            def event_socket() -> str:
                _require(results.get(1, {}).get("ok"), "没有创建样本")
                recorded: list[str] = []
                generated: list[str] = []
                original = RequestContext.set_trace_id
                original_generate = flow_runs_api.generate_trace_id

                @staticmethod
                def spy(trace_id: str) -> None:
                    recorded.append(trace_id)
                    original(trace_id)

                def generate() -> str:
                    value = original_generate()
                    generated.append(value)
                    return value

                RequestContext.set_trace_id = spy  # type: ignore[method-assign]
                flow_runs_api.generate_trace_id = generate
                start = len(recorded)
                try:
                    try:
                        with client.websocket_connect(
                            f"/api/v2/flow/runs/{created['flow_task_id']}/events/accept-conn"
                        ):
                            pass
                    except WebSocketDisconnect:
                        pass
                finally:
                    RequestContext.set_trace_id = original  # type: ignore[method-assign]
                    flow_runs_api.generate_trace_id = original_generate
                _require(generated, "事件连接 accept 之后没有调用自己的 generate_trace_id")
                fresh = [item for item in recorded[start:] if item == generated[-1]]
                _require(fresh, f"accept 之后的 RequestContext 不是 socket 这张：{recorded[start:]} / {generated}")
                _require(TRACE_ID.fullmatch(generated[-1]), f"socket trace 格式不对：{generated[-1]}")
                _require(generated[-1] != created["body_trace"], "socket trace 和 run trace 相同")
                command = next(
                    document
                    for document in database["workflow_command"].docs
                    if document["command_id"] == "accept-obs-create"
                )
                _require(command["trace_id"] == created["body_trace"], "事件连接改了命令上的 run trace")
                stored = next(
                    document
                    for document in database["flow_task"].docs
                    if document["flow_task_id"] == created["flow_task_id"]
                )
                _require(stored["trace_id"] == created["body_trace"], "事件连接改了 flow_task.trace_id")
                return f"socket RequestContext={generated[-1]}，命令和 flow_task 仍是 {created['body_trace']}"

            if results.get(1, {}).get("ok"):
                _record(results, 5, event_socket)

            def readyz_file_and_sockets() -> str:
                _require(publisher_health.PUBLISHER_MAINTENANCE_PATH == str(maintenance), "维护文件路径被改丢了")
                _require(not maintenance.exists(), "验收用的维护文件一开始不应该存在")
                flow_runs_api._workflow_sockets.clear()
                flow_runs_api._workflow_sockets[("accept-task", "accept-socket")] = object()
                open_response = client.get("/readyz")
                _require(open_response.status_code == 200, f"没有维护文件时 /readyz 不是 200：{open_response.status_code}")
                _require(open_response.json() == {"status": "ok", "active_ws": 1}, open_response.json())
                maintenance.write_text("draining", encoding="utf-8")
                draining = client.get("/readyz")
                _require(draining.status_code == 503, f"维护文件存在时 /readyz 不是 503：{draining.status_code}")
                _require(draining.json() == {"status": "draining", "active_ws": 1}, draining.json())
                maintenance.unlink()
                return "无维护文件时 200，active_ws=1；文件出现后 503 draining，active_ws 仍是 1"

            def consumer_health_split() -> str:
                maintenance.unlink(missing_ok=True)
                flow_runs_api._workflow_sockets.clear()
                _ProbeHandler.paths.clear()
                consumer = client.get("/health/consumer")
                ready = client.get("/readyz")
                paths = list(_ProbeHandler.paths)
                _require(consumer.status_code == 503, f"一边 /health 失败时 /health/consumer 不是 503：{consumer.status_code} {consumer.text}")
                body = consumer.json()
                _require(body["status"] == "degraded", body)
                _require(body["consumers"]["blue"]["status"] == "error", body["consumers"]["blue"])
                _require(body["consumers"]["green"]["status"] == "ok", body["consumers"]["green"])
                _require(paths, "没有打到 Consumer")
                _require(all(path == "/health" for _port, path in paths), f"打到了 /health 以外的路径：{paths}")
                ports = {port for port, _path in paths}
                _require(ports == {blue.server_address[1], green.server_address[1]}, f"没有打满 blue 和 green：{paths}")
                hits_after_consumer = len(paths)
                _require(ready.status_code == 200, f"Consumer 一边失败后 Publisher /readyz 不是 200：{ready.status_code} {ready.text}")
                _require(ready.json() == {"status": "ok", "active_ws": 0}, ready.json())
                _require(len(_ProbeHandler.paths) == hits_after_consumer, "Publisher /readyz 又去打了 Consumer")
                return (
                    f"blue/green 都只打了 /health，blue=500 时 /health/consumer=503 degraded，"
                    f"Publisher /readyz 仍是 200 active_ws=0"
                )

            _record(results, 10, readyz_file_and_sockets)
            _record(results, 12, consumer_health_split)

            def publisher_started() -> str:
                health = client.get("/health")
                ready = client.get("/readyz")
                _require(health.status_code == 200, "空 DSN 下 /health 没有起来")
                _require(ready.status_code == 200, "维护文件已清掉，/readyz 仍不是 200")
                return _publisher_sentry() + " Publisher /health 与 /readyz 可以连续打开。"

            sentry_parts["publisher"] = ""
            try:
                sentry_parts["publisher"] = publisher_started()
            except Exception as exc:
                sentry_parts["publisher"] = _format_error(exc)
    finally:
        settings.consumer_blue_url = previous_blue
        settings.consumer_green_url = previous_green
        publisher_health.PUBLISHER_MAINTENANCE_PATH = previous_maintenance
        flow_runs_api._workflow_sockets.clear()
        flow_runs_api._workflow_sockets.update(previous_sockets)
        blue.shutdown()
        green.shutdown()
        blue.server_close()
        green.server_close()
        maintenance.unlink(missing_ok=True)


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
        import app.core.sentry as consumer_sentry
        import app.logger.logger as consumer_logger
        import app.main as consumer_main
        import app.services.invocation.model_invocation_service as invocation_service
        import app.services.workflow.flow_command_inbox_service as inbox_service
        import app.tasks.flow as consumer_flow
        import app.utils.trace_context as trace_context

        self.modules = {
            "config": consumer_config,
            "flow": consumer_flow,
            "inbox": inbox_service,
            "invocation": invocation_service,
            "logger": consumer_logger,
            "main": consumer_main,
            "sentry": consumer_sentry,
            "trace": trace_context,
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


class _ConsumerRedis:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}
        self.sets: dict[str, set[str]] = {}
        self.lengths: dict[str, int] = {}

    async def get(self, key: str) -> object:
        return self.values.get(key)

    async def scard(self, key: str) -> int:
        return len(self.sets.get(key, set()))

    async def xlen(self, key: str) -> int:
        return self.lengths.get(key, 0)


def _run_consumer(results: dict[int, dict[str, Any]], sentry_parts: dict[str, str]) -> None:
    with _ConsumerSwap() as modules:
        settings = modules["config"].get_settings()
        settings.sentry_dsn = ""
        settings.consumer_instance_id = "accept-consumer"
        settings.readyz_max_flow_resume_backlog = 0
        settings.readyz_max_stale_webhook_invocations = 0
        _require(
            modules["config"].Settings.model_fields["readyz_max_flow_resume_backlog"].default == 0,
            "READYZ_MAX_FLOW_RESUME_BACKLOG 默认不是 0",
        )
        _require(
            modules["config"].Settings.model_fields["readyz_max_stale_webhook_invocations"].default == 0,
            "READYZ_MAX_STALE_WEBHOOK_INVOCATIONS 默认不是 0",
        )

        previous_sdk = sys.modules.get("sentry_sdk")

        class BoomSdk:
            @staticmethod
            def init(**_kwargs: Any) -> None:
                raise AssertionError("Consumer 空 DSN 不应该初始化 Sentry")

        sys.modules["sentry_sdk"] = BoomSdk()
        try:
            modules["sentry"].init_sentry("", "accept")
            consumer_app = modules["main"].create_app()
        finally:
            if previous_sdk is None:
                sys.modules.pop("sentry_sdk", None)
            else:
                sys.modules["sentry_sdk"] = previous_sdk

        class _Metrics:
            def __init__(self) -> None:
                self.calls: list[dict[str, Any]] = []

            def distribution(self, name: str, value: float, unit: str | None = None, attributes: dict[str, Any] | None = None) -> None:
                self.calls.append(
                    {"attributes": attributes, "name": name, "unit": unit, "value": value}
                )

        metrics = _Metrics()

        class _Sdk:
            def __init__(self) -> None:
                self.metrics = metrics

            @staticmethod
            def continue_trace(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {}

            @staticmethod
            def start_transaction(**_kwargs: Any) -> None:
                return None

            @staticmethod
            def set_tag(*_args: Any, **_kwargs: Any) -> None:
                return None

            @staticmethod
            def set_user(*_args: Any, **_kwargs: Any) -> None:
                return None

        claimed: list[str] = []

        async def claim(cls: Any, _database: Any, **kwargs: Any) -> SimpleNamespace:
            del cls
            claimed.append(str(kwargs["command_id"]))
            return SimpleNamespace(claimed=False, conflict=False, document={}, lease_token=None)

        modules["inbox"].FlowCommandInboxService.claim_command = classmethod(claim)
        sys.modules["sentry_sdk"] = _Sdk()
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter(modules["logger"].LOG_FORMAT))
        handler.addFilter(modules["logger"].TraceIdFilter())
        modules["logger"].log.addHandler(handler)
        try:

            def logs_and_delay() -> None:
                run_trace = "1-66f00001-abcdefabcdefabcdefabcd"
                modules["trace"].set_trace_id("stale-request")
                started = time.time()
                publish_timestamp = started - 2.5

                held_trace: list[str | None] = []

                async def once() -> None:
                    await modules["flow"].FlowTask.run_flow(
                        object(),
                        {
                            "command_id": "cmd-accept",
                            "flow_id": "flow-1",
                            "flow_run_id": "run-1",
                            "flow_run_type": "start",
                            "flow_task_id": "task-1",
                            "protocol_version": 2,
                            "publish_timestamp": publish_timestamp,
                            "trace_id": run_trace,
                            "user_id": "user-1",
                        },
                        publisher=object(),
                    )
                    held_trace.append(modules["trace"].get_trace_id())

                asyncio.run(once())
                finished = time.time()
                text = stream.getvalue()
                _require(run_trace in text, f"日志里搜不到 run trace：{text}")
                _require(f"[trace_id={run_trace}]" in text, f"日志没有带上 run 这张：{text}")
                _require(held_trace == [run_trace], f"入口没有改成消息里的 trace：{held_trace}")
                _require(claimed == ["cmd-accept"], "有 publish_timestamp 时任务没有进到认领")
                _require(metrics.calls, "没有打出 flow.queue_delay")
                sample = metrics.calls[0]
                _require(sample["name"] == "flow.queue_delay", sample)
                _require(sample["unit"] == "second", sample)
                _require(sample["attributes"] == {"flow_run_type": "start"}, sample["attributes"])
                delay = float(sample["value"])
                lower = started - publish_timestamp
                upper = finished - publish_timestamp
                _require(lower - 0.05 <= delay <= upper + 0.05, f"queue_delay={delay} 不在 publish 到入口的 {lower:.3f}-{upper:.3f}")
                modules["trace"].set_trace_id(None)
                modules["logger"].log.info("empty context")
                _require("[trace_id=N/A]" in stream.getvalue(), stream.getvalue())
                _require(modules["trace"].get_trace_id() is None, "空上下文没有清掉")

                async def without_timestamp() -> None:
                    await modules["flow"].FlowTask.run_flow(
                        object(),
                        {
                            "command_id": "cmd-no-ts",
                            "flow_run_type": "start",
                            "flow_task_id": "task-2",
                            "protocol_version": 2,
                            "trace_id": run_trace,
                        },
                        publisher=object(),
                    )

                before_calls = len(metrics.calls)
                asyncio.run(without_timestamp())
                _require(len(metrics.calls) == before_calls, "没有 publish_timestamp 也打了 flow.queue_delay")
                _require(claimed[-1] == "cmd-no-ts", "没有 publish_timestamp 时任务没有继续")

            try:
                logs_and_delay()
                results[6] = {
                    "step": 6,
                    "name": _STEP_TITLES[5],
                    "ok": True,
                    "detail": "run_flow 日志含 [trace_id=1-66f00001-abcdefabcdefabcdefabcd]；set_trace_id(None) 后是 [trace_id=N/A]",
                }
                delay = metrics.calls[0]["value"]
                results[7] = {
                    "step": 7,
                    "name": _STEP_TITLES[6],
                    "ok": True,
                    "detail": f"flow.queue_delay={delay}s，attribute 只有 flow_run_type=start，量的是 publish_timestamp 到 run_flow 入口",
                }
            except Exception as exc:
                message = _format_error(exc)
                results[6] = {"step": 6, "name": _STEP_TITLES[5], "ok": False, "detail": message}
                results[7] = {"step": 7, "name": _STEP_TITLES[6], "ok": False, "detail": message}

            def callback_clears() -> str:
                seen: list[str | None] = []
                original = modules["trace"].set_trace_id

                inside_callback: list[str | None] = []

                def spy(trace_id: str | None) -> None:
                    seen.append(trace_id)
                    original(trace_id)
                    inside_callback.append(modules["trace"].get_trace_id())

                modules["main"].set_trace_id = spy
                modules["trace"].set_trace_id("stale-request")
                database = FakeDatabase()
                database["model_invocations"].docs.append(
                    {
                        "external_task_id": "ai-1",
                        "invocation_id": "inv-1",
                        "metadata": {},
                        "run_id": "run-1",
                        "status": "success",
                        "vendor": "opencreator_ai",
                    }
                )
                database["flow_run_state"].docs.append({"run_id": "run-1", "trace_id": "trace-run"})

                @asynccontextmanager
                async def lifespan(app: Any) -> Any:
                    app.state.connections = SimpleNamespace(
                        mongo={settings.mongo_database: database},
                        redis=_ConsumerRedis(),
                    )
                    yield

                consumer_app.router.lifespan_context = lifespan
                with TestClient(consumer_app) as client:
                    response = client.post("/callbacks/models/opencreator_ai", content=b"{}")
                _require(seen and seen[0] is None, f"回调入口没有先清掉上一张：{seen}")
                _require(inside_callback and inside_callback[0] is None, f"回调入口清完后还带着上一张：{inside_callback}")
                _require(response.status_code in {400, 401}, response.text)

                restored: list[str | None] = []

                async def matched() -> None:
                    modules["trace"].set_trace_id("stale-request")
                    await modules["invocation"].ModelInvocationService.handle_callback_fast(
                        database,
                        vendor="opencreator_ai",
                        payload={"ai_task_id": "ai-1", "status": "success", "trace_id": "trace-callback"},
                        idempotency_key="delivery-1",
                    )
                    restored.append(modules["trace"].get_trace_id())

                asyncio.run(matched())
                _require(restored == ["trace-callback"], restored)

                async def from_flow() -> None:
                    modules["trace"].set_trace_id("stale-request")
                    await modules["invocation"].ModelInvocationService.handle_callback_fast(
                        database,
                        vendor="opencreator_ai",
                        payload={"ai_task_id": "ai-1", "status": "success"},
                        idempotency_key="delivery-1",
                    )
                    restored.append(modules["trace"].get_trace_id())

                asyncio.run(from_flow())
                _require(restored[-1] == "trace-run", restored)
                return "回调入口先 set_trace_id(None)。对上之后用 callback 或 flow 的 trace，不用上一张 stale-request。"

            _record(results, 8, callback_clears)

            def readyz_thresholds() -> str:
                redis = _ConsumerRedis()
                redis.lengths[settings.flow_resume_queue_name] = 500
                database = FakeDatabase()
                from datetime import UTC, datetime, timedelta

                database["model_invocations"].docs.append(
                    {
                        "execution_mode": "webhook",
                        "status": "running",
                        "updated_at": datetime.now(UTC) - timedelta(days=2),
                    }
                )

                @asynccontextmanager
                async def lifespan(app: Any) -> Any:
                    app.state.connections = SimpleNamespace(
                        mongo={settings.mongo_database: database},
                        redis=redis,
                    )
                    yield

                consumer_app.router.lifespan_context = lifespan
                with TestClient(consumer_app) as client:
                    open_response = client.get("/readyz")
                    redis.values[f"opencreator:consumer:intake:{settings.consumer_instance_id}"] = b"DRAINING"
                    redis.sets[f"opencreator:consumer:inflight:{settings.consumer_instance_id}"] = {"job-1"}
                    draining = client.get("/readyz")
                _require(open_response.status_code == 200, open_response.text)
                open_body = open_response.json()
                _require(open_body["flow_engine"]["flow_resume_backlog"] == 500, open_body)
                _require("flow_engine" in open_body, open_body)
                _require(draining.status_code == 503, draining.text)
                draining_body = draining.json()
                _require(draining_body["status"] == "draining", draining_body)
                _require("flow_engine" in draining_body, draining_body)
                return "阈值 0、积压 500 时 /readyz=200，body.flow_engine.flow_resume_backlog=500。DRAINING 时 503，body 仍有 flow_engine。"

            _record(results, 11, readyz_thresholds)

            class InsufficientCredits(Exception):
                pass

            try:
                _require(modules["sentry"].traces_sampler({"transaction_context": {"name": "/health"}}) == 0, "Consumer /health 仍被采样")
                _require(modules["sentry"].traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0, "Consumer /readyz 仍被采样")
                _require(
                    modules["sentry"].before_send_transaction({"transaction": "/health"}, {}) is None,
                    "Consumer /health transaction 会送出",
                )
                dropped = modules["sentry"].before_send(
                    {"extra": {"prompt": "secret"}},
                    {"exc_info": (InsufficientCredits, InsufficientCredits(), None)},
                )
                _require(dropped is None, "Consumer 预期业务异常会进 issue")
                sentry_parts["consumer"] = "Consumer 空 DSN 能 create_app。/health 与 /readyz 采样为 0。InsufficientCredits 不进 issue。"
            except Exception as exc:
                sentry_parts["consumer"] = _format_error(exc)
        finally:
            modules["logger"].log.removeHandler(handler)
            if previous_sdk is None:
                sys.modules.pop("sentry_sdk", None)
            else:
                sys.modules["sentry_sdk"] = previous_sdk


def _run_agent(results: dict[int, dict[str, Any]], sentry_parts: dict[str, str]) -> None:
    sys.path.insert(0, str(ROOT / "novelcomic-agent" / "src"))
    from novelcomic_agent.api.server import _running_run_tasks
    from novelcomic_agent.config import Settings
    from novelcomic_agent.main import create_app as create_agent_app
    from novelcomic_agent.sentry import init_sentry as agent_init_sentry
    from novelcomic_agent.sentry import traces_sampler as agent_traces_sampler

    previous = sys.modules.get("sentry_sdk")

    class BoomSdk:
        @staticmethod
        def init(**_kwargs: Any) -> None:
            raise AssertionError("Agent 空 DSN 不应该初始化 Sentry")

    sys.modules["sentry_sdk"] = BoomSdk()
    try:
        agent_init_sentry("", "accept")
        _require(agent_traces_sampler({"transaction_context": {"name": "/health"}}) == 0, "Agent /health 仍被采样")
        _require(agent_traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0, "Agent /readyz 仍被采样")
    finally:
        if previous is None:
            sys.modules.pop("sentry_sdk", None)
        else:
            sys.modules["sentry_sdk"] = previous

    class Manager:
        async def start(self) -> None:
            return None

        async def close(self) -> None:
            return None

        async def check_all(self) -> dict[str, dict[str, str]]:
            return {"mongodb": {"status": "ok"}, "redis": {"status": "ok"}}

    app = create_agent_app(
        Settings(sentry_dsn="", posthog_api_key="", posthog_enabled=False),
        dependency_manager=Manager(),  # type: ignore[arg-type]
    )
    _running_run_tasks.clear()
    _running_run_tasks["run-1"] = object()  # type: ignore[assignment]
    try:
        with TestClient(app, client=("10.1.2.3", 50000)) as remote:
            denied = remote.post("/preview/drain")
            health = remote.get("/health")
        with TestClient(app, client=("127.0.0.1", 50000)) as local:
            drained = local.post("/preview/drain")
            local_health = local.get("/health")
        _require(denied.status_code == 404, f"非本机 /preview/drain 不是 404：{denied.status_code}")
        _require(health.status_code == 200 and health.json() == {"status": "ok"}, health.text)
        _require("run-1" not in health.text, "公开 /health 带上了 active run")
        _require(drained.status_code == 200, drained.text)
        _require(local_health.json() == {"status": "ok"}, local_health.text)
        results[15] = {
            "step": 15,
            "name": _STEP_TITLES[14],
            "ok": True,
            "detail": "10.1.2.3 POST /preview/drain=404。公开 /health 是 {status: ok}，不含 run-1。本机 drain 后 /health 仍是 ok。",
        }
        sentry_parts["agent"] = "Agent 空 DSN 不初始化，/health 与 /readyz 采样为 0，进程能打开 /health。"
    except Exception as exc:
        results[15] = {"step": 15, "name": _STEP_TITLES[14], "ok": False, "detail": _format_error(exc)}
        sentry_parts["agent"] = _format_error(exc)
    finally:
        _running_run_tasks.clear()


def _start_node(kind: str, report: Path) -> subprocess.Popen[str]:
    env = os.environ.copy()
    if kind == "ai":
        env["ACCEPT_AI_REPORT"] = str(report)
        command = [
            str(ROOT / "novelcomic-ai" / "node_modules" / ".bin" / "vitest"),
            "run",
            "scripts/accept-observability-health-slo.ai.test.ts",
        ]
        cwd = ROOT / "novelcomic-ai"
    else:
        env["ACCEPT_FRONTEND_REPORT"] = str(report)
        command = [
            str(ROOT / "novelcomic-frontend" / "node_modules" / ".bin" / "vitest"),
            "run",
            "src/lib/accept-observability-health-slo.test.tsx",
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
        message = f"{kind} 验收没有通过：{tail}"
        if kind == "ai":
            return {"13": message, "14": message}
        return {"16": message}
    payload = json.loads(report.read_text(encoding="utf-8"))
    return {str(key): str(value) for key, value in payload.items()}


def main() -> int:
    ai_report = Path(tempfile.mkstemp(prefix="accept-obs-ai-", suffix=".json")[1])
    frontend_report = Path(tempfile.mkstemp(prefix="accept-obs-fe-", suffix=".json")[1])
    ai_proc = _start_node("ai", ai_report)
    frontend_proc = _start_node("frontend", frontend_report)
    results: dict[int, dict[str, Any]] = {}
    sentry_parts: dict[str, str] = {}
    try:
        _run_publisher(results, sentry_parts)
        _run_consumer(results, sentry_parts)
        _run_agent(results, sentry_parts)
    except Exception as exc:
        for step in range(1, 16):
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

    publisher_ok = sentry_parts.get("publisher", "").startswith("Publisher")
    consumer_ok = sentry_parts.get("consumer", "").startswith("Consumer")
    agent_ok = sentry_parts.get("agent", "").startswith("Agent")
    sentry_ok = publisher_ok and consumer_ok and agent_ok
    results[9] = {
        "step": 9,
        "name": _STEP_TITLES[8],
        "ok": sentry_ok,
        "detail": " ".join(
            sentry_parts.get(name) or f"{name} 没有跑到"
            for name in ("publisher", "consumer", "agent")
        ),
    }
    for step, key in ((13, "13"), (14, "14"), (16, "16")):
        detail = node.get(key) or "没有拿到这条的验收输出"
        failed = detail.startswith("ai 验收没有通过") or detail.startswith("frontend 验收没有通过") or key not in node
        results[step] = {
            "step": step,
            "name": _STEP_TITLES[step - 1],
            "ok": not failed and bool(node.get(key)),
            "detail": detail,
        }

    passed = 0
    print("观测告警健康与 SLO 验收")
    print()
    for step in range(1, 17):
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
    print(f"勾选 {passed}/16。")
    print("验收到证据能对上、探活语义分开、告警失败留在通知通道。用户旅程的目标值和错误预算另开口径，不在这次编写里交付。")
    return 0 if passed == 16 else 1


if __name__ == "__main__":
    raise SystemExit(main())
