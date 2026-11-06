#!/usr/bin/env python3
"""按 Agent 会话 SSE 与运行循环的 18 条验收顺序，打服务端协议和前端订阅。

用法：
  novelcomic-agent/.venv/bin/python scripts/accept-agent-sse-run-loop.py
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "novelcomic-agent" / "src"))

from novelcomic_agent.agents.main.profile import DEFAULT_AGENT_FACTORY  # noqa: E402
from novelcomic_agent.config import Settings  # noqa: E402
from novelcomic_agent.core.loop import AgentLoop, HitlInterrupt  # noqa: E402
from novelcomic_agent.main import create_app  # noqa: E402
from novelcomic_agent.services.agent_redis_run_store import RedisRunStore  # noqa: E402

_CLIENT_STEPS = (4, 7, 8, 9, 10, 12, 14, 16, 17, 18)
_STEP_TITLES = [
    "未登录调用 Agent API 被拒绝",
    "POST /v1/agent/runs 缺少必要字段时返回可解释错误",
    "同一个 client_request_id 重试返回同一个 run_id，不重复开 loop",
    "同一个 session 已有 active run 时，新请求返回 409 或复用 active_run_id",
    "GET /v1/agent/runs/{run_id}/events 校验用户归属，不能订阅别人的 run",
    "SSE Content-Type 是 text/event-stream",
    "没有事件时发送 heartbeat comment，不改变 UI",
    "chat.message.delta 能流式显示文本",
    "tool.started / tool.completed 能显示工具卡片",
    "tool.event=hitl.request 能显示 HITL 卡片",
    "HITL 回复后，下一条用户消息能注入 tool result 并继续 loop",
    "workflow.node_status 能更新聊天中的 workflow 卡片，必要时同步画布状态",
    "run.completed 后 SSE 正常结束，active run 被清理",
    "刷新页面后，active-run 能找回正在跑的 run，并继续订阅 SSE",
    "Last-Event-ID 在恢复窗口内能补事件",
    "恢复窗口过期返回 410 RESUME_WINDOW_EXPIRED，前端重新拉历史而不是无限重试",
    "用户取消时 abort SSE，并调用 run cancel 或 cancel-by-request",
    "旧 POST /v1/agent/chat 返回 410 USE_AGENT_RUNS，不会被新前端继续使用",
]
_ORIGINAL_AGENT_BUILD = DEFAULT_AGENT_FACTORY.build
_ORIGINAL_AGENT_RUN = AgentLoop.run
_LOOP_STARTS: list[str] = []


class _EchoTool:
    name = "echo"
    description = "Acceptance echo tool."

    async def execute(self, arguments: dict[str, Any], context: Any) -> dict[str, Any]:
        del context
        if arguments.get("hitl"):
            data = arguments.get("data") if isinstance(arguments.get("data"), dict) else {}
            raise HitlInterrupt(
                tool_call_id="pending",
                hitl_type=str(arguments.get("type") or "select"),
                data=data,
                tool_name=self.name,
            )
        return {"text": arguments.get("text", "ok")}


class ScriptedLlm:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.plans: list[dict[str, Any]] = []
        self.hold = False
        self.generation = 0
        self.release = threading.Event()

    def prepare(self, plans: list[dict[str, Any]] | None = None, *, hold: bool = False) -> None:
        self.generation += 1
        self.release.set()
        self.calls = []
        self.plans = list(plans or [])
        self.hold = hold
        self.release = threading.Event()

    async def complete(self, **payload: Any) -> dict[str, Any]:
        generation = self.generation
        if generation != self.generation:
            return {"content": "", "tool_calls": []}
        self.calls.append(json.loads(json.dumps(payload, default=str)))
        if self.hold:
            while not self.release.is_set() and generation == self.generation:
                await asyncio.sleep(0.02)
        if generation != self.generation:
            return {"content": "", "tool_calls": []}
        if self.plans:
            return self.plans.pop(0)
        return {"content": "完成了", "tool_calls": []}


def _install_echo_tool() -> None:
    def build(ctx: Any, name: str = "main") -> Any:
        runtime = _ORIGINAL_AGENT_BUILD(ctx, name)
        runtime.tools["echo"] = _EchoTool()
        return runtime

    DEFAULT_AGENT_FACTORY.build = build  # type: ignore[method-assign]


async def _counting_run(self: AgentLoop, request: Any) -> Any:
    _LOOP_STARTS.append(request.run_id)
    return await _ORIGINAL_AGENT_RUN(self, request)


def _require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(str(message))


def _format_error(exc: Exception) -> str:
    if isinstance(exc, AssertionError):
        return str(exc) or exc.__class__.__name__
    return "".join(traceback.format_exception(exc)).strip()


def _join(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    return f"{left}；{right}"


def _auth(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {user_id}-token", "X-User-Id": user_id}


def _code(response: Any) -> str:
    body = response.json()
    detail = body.get("detail")
    if isinstance(detail, dict) and detail.get("code"):
        return str(detail["code"])
    if body.get("code"):
        return str(body["code"])
    return ""


def _active_run_id(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    if isinstance(body.get("active_run_id"), str):
        return str(body["active_run_id"])
    detail = body.get("detail")
    if isinstance(detail, dict) and isinstance(detail.get("active_run_id"), str):
        return str(detail["active_run_id"])
    return None


def _parse_sse(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    comments: list[str] = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        event: dict[str, Any] = {}
        data_lines: list[str] = []
        for raw_line in block.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith(":"):
                comments.append(line[1:].strip())
                continue
            field, _, value = line.partition(":")
            value = value.strip()
            if field == "id":
                event["id"] = value
            elif field == "event":
                event["event"] = value
            elif field == "data":
                data_lines.append(value)
        if data_lines:
            event["data"] = json.loads("\n".join(data_lines))
        if event.get("event"):
            events.append(event)
    return events, comments


def _wait_until(predicate: Any, timeout: float = 5, label: str = "条件") -> None:
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"{timeout:g}s 内没有等到{label}")


def _run_vitest() -> list[dict[str, Any]]:
    vitest = ROOT / "novelcomic-frontend" / "node_modules" / ".bin" / "vitest"
    _require(vitest.exists(), f"找不到前端 vitest: {vitest}")
    descriptor, name = tempfile.mkstemp(prefix="accept-agent-sse-", suffix=".json")
    os.close(descriptor)
    report = Path(name)
    try:
        completed = subprocess.run(
            [
                str(vitest),
                "run",
                "src/features/agent-chat/accept-agent-sse-run-loop.test.ts",
                "--reporter=json",
                f"--outputFile={report}",
            ],
            check=False,
            cwd=ROOT / "novelcomic-frontend",
            capture_output=True,
            text=True,
        )
        try:
            payload = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            tail = (completed.stdout + completed.stderr)[-2000:]
            raise AssertionError(f"前端验收没有产出 JSON: {exc}; {tail}") from exc
    finally:
        report.unlink(missing_ok=True)

    cases: list[dict[str, Any]] = []
    for suite in payload.get("testResults") or []:
        for item in suite.get("assertionResults") or []:
            title = str(item.get("title") or "")
            matched = re.match(r"\[(\d+)\]", title)
            if matched is None:
                continue
            failures = item.get("failureMessages") or []
            cases.append(
                {
                    "detail": str(failures[0])[:500] if failures else "",
                    "ok": item.get("status") == "passed",
                    "step": int(matched.group(1)),
                    "title": title,
                }
            )
    if not cases:
        tail = (completed.stdout + completed.stderr)[-2000:]
        raise AssertionError(f"前端验收没有用例结果: {tail}")
    return cases


def _apply_frontend(results: list[dict[str, Any]]) -> None:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for case in _run_vitest():
        grouped.setdefault(int(case["step"]), []).append(case)
    for step in _CLIENT_STEPS:
        item = results[step - 1]
        cases = grouped.get(step) or []
        if not cases:
            item["ok"] = False
            item["detail"] = _join(item["detail"], "没有对应的前端用例")
            continue
        summary = "，".join(f"{case['title']}={'通过' if case['ok'] else '失败'}" for case in cases)
        failed = [case for case in cases if not case["ok"]]
        if failed:
            item["ok"] = False
            item["detail"] = _join(item["detail"], f"{summary} {failed[0]['detail']}")
        else:
            item["detail"] = _join(item["detail"], summary)


def _guard(results: list[dict[str, Any]], steps: tuple[int, ...], fn: Any) -> None:
    try:
        details = fn()
    except Exception as exc:
        message = _format_error(exc)
        for step in steps:
            item = results[step - 1]
            item["ok"] = False
            item["detail"] = _join(item["detail"], message)
        return
    for step, detail in details.items():
        results[step - 1]["detail"] = _join(results[step - 1]["detail"], str(detail))


def _sort_value(value: Any) -> tuple[int, Any]:
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (0, value)
    if isinstance(value, str):
        return (1, value)
    return (2, "")


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: Any, direction: int = 1) -> FakeCursor:
        if isinstance(key, list):
            for field, field_direction in reversed(key):
                self.docs.sort(key=lambda item, name=field: _sort_value(item.get(name)), reverse=int(field_direction) < 0)
        else:
            self.docs.sort(key=lambda item, name=key: _sort_value(item.get(name)), reverse=direction < 0)
        return self

    def limit(self, count: int) -> FakeCursor:
        self.docs = self.docs[:count]
        return self

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        docs = self.docs if length is None else self.docs[:length]
        return [copy.deepcopy(doc) for doc in docs]

    def __aiter__(self) -> FakeCursor:
        self._iter = iter(self.docs)
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return copy.deepcopy(next(self._iter))
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
        for key, expected in query.items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if "$in" in expected and actual not in expected["$in"]:
                    return False
                if "$lt" in expected and not (actual is not None and actual < expected["$lt"]):
                    return False
                if "$in" not in expected and "$lt" not in expected:
                    return False
                continue
            if actual != expected:
                return False
        return True

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(copy.deepcopy(document))

    async def insert_many(self, documents: list[dict[str, Any]], ordered: bool = True) -> None:
        del ordered
        self.docs.extend(copy.deepcopy(document) for document in documents)

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
        sort: list[tuple[str, int]] | None = None,
    ) -> dict[str, Any] | None:
        del projection
        matched = [doc for doc in self.docs if self._matches(doc, query)]
        if sort:
            for field, direction in reversed(sort):
                matched.sort(key=lambda item, name=field: _sort_value(item.get(name)), reverse=direction < 0)
        if not matched:
            return None
        return copy.deepcopy(matched[0])

    def find(self, query: dict[str, Any], projection: dict[str, int] | None = None) -> FakeCursor:
        del projection
        matched = [copy.deepcopy(doc) for doc in self.docs if self._matches(doc, query)]
        return FakeCursor(matched)

    async def update_one(self, query: dict[str, Any], update: dict[str, Any], upsert: bool = False) -> None:
        for document in self.docs:
            if self._matches(document, query):
                document.update(copy.deepcopy(update.get("$set") or {}))
                return
        if not upsert:
            return
        created = copy.deepcopy(update.get("$setOnInsert") or {})
        created.update(copy.deepcopy(update.get("$set") or {}))
        if "_id" in query:
            created["_id"] = query["_id"]
        self.docs.append(created)

    async def delete_many(self, query: dict[str, Any]) -> None:
        self.docs = [doc for doc in self.docs if not self._matches(doc, query)]


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
        self.hashes: dict[str, dict[str, str]] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.sets: dict[str, set[str]] = {}
        self.sequence = 0
        self.lock = threading.RLock()

    async def set(self, key: str, value: Any, ex: int | None = None, nx: bool = False) -> bool | None:
        del ex
        with self.lock:
            if nx and key in self.values:
                return None
            self.values[key] = value if isinstance(value, str) else str(value)
            return True

    async def get(self, key: str) -> str | None:
        with self.lock:
            return self.values.get(key)

    async def delete(self, *keys: str) -> int:
        with self.lock:
            removed = 0
            for key in keys:
                removed += int(key in self.values or key in self.hashes or key in self.streams or key in self.sets)
                self.values.pop(key, None)
                self.hashes.pop(key, None)
                self.streams.pop(key, None)
                self.sets.pop(key, None)
            return removed

    async def expire(self, key: str, ttl: int) -> bool:
        del key, ttl
        return True

    async def exists(self, key: str) -> int:
        with self.lock:
            return int(key in self.values or key in self.hashes or key in self.streams or key in self.sets)

    async def hset(self, key: str, mapping: dict[str, Any] | None = None, **kwargs: Any) -> int:
        with self.lock:
            target = self.hashes.setdefault(key, {})
            payload = {**(mapping or {}), **kwargs}
            for field, value in payload.items():
                target[str(field)] = value if isinstance(value, str) else str(value)
            return len(payload)

    async def hgetall(self, key: str) -> dict[str, str]:
        with self.lock:
            return dict(self.hashes.get(key, {}))

    async def xadd(
        self,
        key: str,
        fields: dict[str, Any],
        maxlen: int | None = None,
        approximate: bool = True,
    ) -> str:
        del maxlen, approximate
        with self.lock:
            self.sequence += 1
            redis_id = f"{self.sequence}-0"
            normalized = {
                str(field): value if isinstance(value, str) else str(value) for field, value in fields.items()
            }
            self.streams.setdefault(key, []).append((redis_id, normalized))
            return redis_id

    async def xrange(self, key: str, min: str = "-", max: str = "+", count: int | None = None) -> list[Any]:
        del min, max
        with self.lock:
            entries = list(self.streams.get(key, []))
            return entries[:count] if count is not None else entries

    async def xread(
        self,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> list[Any]:
        with self.lock:
            rows: list[Any] = []
            for key, cursor in streams.items():
                left = _cursor_parts(str(cursor or "0-0"))
                entries = [
                    (entry_id, fields)
                    for entry_id, fields in self.streams.get(key, [])
                    if _cursor_parts(entry_id) > left
                ]
                if count is not None:
                    entries = entries[:count]
                if entries:
                    rows.append((key, entries))
        if rows or not block:
            return rows
        await asyncio.sleep(0.02)
        return []

    async def sadd(self, key: str, *members: str) -> int:
        with self.lock:
            bucket = self.sets.setdefault(key, set())
            before = len(bucket)
            bucket.update(members)
            return len(bucket) - before

    async def srem(self, key: str, *members: str) -> int:
        with self.lock:
            bucket = self.sets.setdefault(key, set())
            removed = 0
            for member in members:
                if member in bucket:
                    bucket.remove(member)
                    removed += 1
            return removed

    async def smembers(self, key: str) -> set[str]:
        with self.lock:
            return set(self.sets.get(key, set()))

    async def eval(self, script: str, numkeys: int, *args: Any) -> int:
        del script
        with self.lock:
            key = str(args[0]) if numkeys else ""
            owner = str(args[numkeys]) if len(args) > numkeys else ""
            if self.values.get(key) == owner:
                self.values.pop(key, None)
                return 1
            return 0


def _cursor_parts(value: str) -> tuple[int, int]:
    left, right = str(value).split("-", 1)
    return int(left), int(right)


class FakeDependencies:
    def __init__(self, database: FakeDatabase, redis_client: FakeRedis, llm: ScriptedLlm) -> None:
        self.mongo = {"novelcomic": database}
        self.redis = redis_client
        self.llm_client = llm
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True

    async def check_all(self) -> dict[str, dict[str, str]]:
        return {
            "mongodb": {"status": "ok"},
            "redis": {"status": "ok"},
            "rabbitmq": {"status": "ok"},
        }


def _post_run(
    client: TestClient,
    user_id: str,
    session_id: str,
    message: str,
    client_request_id: str,
) -> Any:
    return client.post(
        "/v1/agent/runs",
        headers=_auth(user_id),
        json={
            "message": message,
            "session_id": session_id,
            "flow_id": "flow-accept",
            "client_request_id": client_request_id,
            "stream": True,
        },
    )


def _seed_run(redis_client: FakeRedis, user_id: str, session_id: str, client_request_id: str) -> str:
    store = RedisRunStore(redis_client)

    async def _create() -> str:
        created = await store.create_run(
            user_id=user_id,
            session_id=session_id,
            flow_id="flow-accept",
            client_request_id=client_request_id,
            request={"message": "seed"},
        )
        await store.mark_status(created.run_id, "running")
        return created.run_id

    return asyncio.run(_create())


def _meta(redis_client: FakeRedis, run_id: str) -> dict[str, str]:
    return asyncio.run(RedisRunStore(redis_client).get_run_meta(run_id))


def _append(redis_client: FakeRedis, run_id: str, event: str, data: dict[str, Any]) -> str:
    return asyncio.run(RedisRunStore(redis_client).append_event(run_id, event, data))


async def _read_sse_asgi(
    app: Any,
    path: str,
    headers: dict[str, str],
    predicate: Any,
    timeout: float,
    box: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Read SSE as ASGI body chunks. TestClient buffers the body until the generator ends."""

    state = box if box is not None else {"text": "", "status": None, "content_type": "", "error": None}
    finished = asyncio.Event()
    scope = {
        "type": "http",
        "asgi": {"spec_version": "2.3", "version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(str(key).lower().encode(), str(value).encode()) for key, value in headers.items()],
        "client": ("127.0.0.1", 123),
        "server": ("testserver", 80),
        "root_path": "",
    }
    request_sent = False

    async def receive() -> dict[str, Any]:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            state["status"] = message["status"]
            decoded = {key.decode().lower(): value.decode() for key, value in message.get("headers", [])}
            state["content_type"] = decoded.get("content-type", "")
            return
        if message["type"] != "http.response.body":
            return
        state["text"] += message.get("body", b"").decode()
        if predicate(state["text"]) or not message.get("more_body", False):
            finished.set()

    app_task = asyncio.create_task(app(scope, receive, send))
    waiter = asyncio.create_task(finished.wait())
    try:
        done, _pending = await asyncio.wait({app_task, waiter}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if app_task in done and not finished.is_set():
            error = app_task.exception()
            if error is not None:
                raise error
        if not finished.is_set():
            raise AssertionError(f"SSE 超时: {state['text'][:500]}")
    finally:
        finished.set()
        waiter.cancel()
        app_task.cancel()
        await asyncio.gather(waiter, app_task, return_exceptions=True)
    return state


def _read_sse(
    app: Any,
    path: str,
    headers: dict[str, str],
    predicate: Any,
    timeout: float = 8,
    box: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return asyncio.run(_read_sse_asgi(app, path, headers, predicate, timeout, box))


def _run(database: FakeDatabase, redis_client: FakeRedis, llm: ScriptedLlm) -> list[dict[str, Any]]:
    _install_echo_tool()
    AgentLoop.run = _counting_run  # type: ignore[method-assign]
    settings = Settings()
    settings.mongodb_database = "novelcomic"
    app = create_app(settings, FakeDependencies(database, redis_client, llm))  # type: ignore[arg-type]
    client_context = TestClient(app)
    client = client_context.__enter__()
    results = [
        {"step": index, "name": title, "ok": True, "detail": ""}
        for index, title in enumerate(_STEP_TITLES, start=1)
    ]

    def check_unauth() -> dict[int, str]:
        calls = [
            client.post("/v1/agent/runs", json={"message": "hi", "session_id": "session-auth"}),
            client.get("/v1/agent/runs/run-missing/events"),
            client.get("/v1/agent/sessions/session-auth/active-run"),
            client.post("/v1/agent/runs/run-missing/cancel"),
        ]
        for response in calls:
            _require(response.status_code == 401, response.text)
            _require(_code(response) == "UNAUTHENTICATED", response.text)
        return {1: "runs/events/active-run/cancel 都是 401 UNAUTHENTICATED"}

    def check_validation() -> dict[int, str]:
        response = client.post("/v1/agent/runs", headers=_auth("user-a"), json={})
        _require(response.status_code == 422, response.text)
        detail = response.json().get("detail")
        _require(isinstance(detail, list) and detail, response.text)
        rendered = " ".join(f"{item.get('loc')} {item.get('msg')}" for item in detail)
        _require("message" in rendered and "session_id" in rendered, response.text)
        _require(all(item.get("msg") for item in detail), response.text)
        return {2: f"422，字段={rendered}"}

    def check_idempotent_and_conflict() -> dict[int, str]:
        llm.prepare([{"content": "第一次", "tool_calls": []}], hold=True)
        _LOOP_STARTS.clear()
        session_id = "session-idem"
        try:
            first = _post_run(client, "user-a", session_id, "你好", "req-same")
            _require(first.status_code == 202, first.text)
            run_id = str(first.json()["run_id"])
            _require(first.json()["created"] is True, first.text)
            _wait_until(
                lambda: _LOOP_STARTS == [run_id] and len(llm.calls) == 1 and _meta(redis_client, run_id).get("status") == "running",
                label="第一个 run 进入 running",
            )
            second = _post_run(client, "user-a", session_id, "你好", "req-same")
            _require(second.status_code == 200, second.text)
            _require(second.json()["run_id"] == run_id, second.text)
            _require(second.json()["created"] is False, second.text)
            _require(_LOOP_STARTS == [run_id], _LOOP_STARTS)
            _require(len(llm.calls) == 1, llm.calls)
            third = _post_run(client, "user-a", session_id, "另一句", "req-other")
            _require(third.status_code == 409, third.text)
            _require(_active_run_id(third.json()) == run_id, third.text)
            return {
                3: f"重试 run_id={run_id}，loop 启动 {len(_LOOP_STARTS)} 次",
                4: f"409 active_run_id={run_id}",
            }
        finally:
            llm.hold = False
            llm.release.set()

    def check_owner() -> dict[int, str]:
        run_id = _seed_run(redis_client, "user-a", "session-owner", "req-owner")
        response = client.get(f"/v1/agent/runs/{run_id}/events", headers=_auth("user-b"))
        _require(response.status_code == 403, response.text)
        _require(_code(response) == "RUN_FORBIDDEN", response.text)
        return {5: f"user-b 订阅 {run_id} 得到 403 RUN_FORBIDDEN"}

    def check_content_type_and_heartbeat() -> dict[int, str]:
        typed_run = _seed_run(redis_client, "user-a", "session-type", "req-type")
        _append(
            redis_client,
            typed_run,
            "run.completed",
            {"session_id": "session-type", "turn_id": "turn-1", "run_id": typed_run, "revision": 1, "seq": 1},
        )
        typed = _read_sse(
            app,
            f"/v1/agent/runs/{typed_run}/events",
            _auth("user-a"),
            lambda text: "event: run.completed" in text,
        )
        _require(typed["status"] == 200, typed)
        _require(str(typed["content_type"]).startswith("text/event-stream"), typed["content_type"])

        quiet_run = _seed_run(redis_client, "user-a", "session-heartbeat", "req-heartbeat")
        quiet = _read_sse(
            app,
            f"/v1/agent/runs/{quiet_run}/events",
            _auth("user-a"),
            lambda text: ": heartbeat" in text,
            timeout=3,
        )
        events, comments = _parse_sse(str(quiet["text"]))
        _require(quiet["status"] == 200, quiet)
        _require("heartbeat" in comments, quiet["text"])
        _require(events == [], events)
        return {
            6: f"content-type={typed['content_type']}",
            7: "没有事件时返回 : heartbeat，解析后没有状态事件",
        }

    def check_text_replay() -> dict[int, str]:
        llm.prepare([{"content": "流式你好", "tool_calls": []}])
        created = _post_run(client, "user-a", "session-text", "请回答", "req-text")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        live = _read_sse(
            app,
            f"/v1/agent/runs/{run_id}/events",
            _auth("user-a"),
            lambda text: "event: run.completed" in text or "event: run.failed" in text,
        )
        events, _comments = _parse_sse(str(live["text"]))
        names = [event["event"] for event in events]
        _require("run.failed" not in names, live["text"][:800])
        deltas = [event for event in events if event["event"] == "chat.message.delta"]
        _require(any(event["data"].get("text") == "流式你好" for event in deltas), events)
        _require(names[-1] == "run.completed", names)
        idle = client.get("/v1/agent/sessions/session-text/active-run", headers=_auth("user-a"))
        _require(idle.status_code == 200, idle.text)
        _require(idle.json().get("run_id") in {None, ""}, idle.text)

        first_id = str(events[0]["id"])
        replay = _read_sse(
            app,
            f"/v1/agent/runs/{run_id}/events",
            {**_auth("user-a"), "Last-Event-ID": first_id},
            lambda text: "event: run.completed" in text or "event: run.failed" in text,
        )
        replayed, _replay_comments = _parse_sse(str(replay["text"]))
        replay_names = [event["event"] for event in replayed]
        _require(replayed, replay["text"])
        _require(all(event.get("id") != first_id for event in replayed), replayed)
        _require(replay_names == names[1:], (replay_names, names))
        return {
            8: "chat.message.delta=流式你好",
            13: f"run.completed 后 active-run={idle.json().get('run_id')}",
            15: f"Last-Event-ID={first_id} 补回 {replay_names}",
        }

    def check_tools() -> dict[int, str]:
        llm.prepare(
            [
                {
                    "content": "",
                    "tool_calls": [{"id": "call-echo", "name": "echo", "arguments": {"text": "画一张"}}],
                },
                {"content": "工具完成", "tool_calls": []},
            ]
        )
        created = _post_run(client, "user-a", "session-tool", "调用工具", "req-tool")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        live = _read_sse(
            app,
            f"/v1/agent/runs/{run_id}/events",
            _auth("user-a"),
            lambda text: "event: run.completed" in text or "event: run.failed" in text,
        )
        events, _comments = _parse_sse(str(live["text"]))
        names = [event["event"] for event in events]
        _require("run.failed" not in names, live["text"][:800])
        started = next(event for event in events if event["event"] == "tool.started")
        completed = next(event for event in events if event["event"] == "tool.completed")
        _require(started["data"].get("tool_name") == "echo", started)
        _require(names.index("tool.started") < names.index("tool.completed"), names)
        _require(completed["data"].get("tool_call_id") == started["data"].get("tool_call_id"), completed)
        return {9: f"tool.started/completed tool_call_id={completed['data'].get('tool_call_id')}"}

    def check_hitl() -> dict[int, str]:
        llm.prepare(
            [
                {
                    "content": "先等你选",
                    "tool_calls": [
                        {
                            "id": "call-hitl",
                            "name": "echo",
                            "arguments": {
                                "hitl": True,
                                "type": "select",
                                "data": {
                                    "title": "请选择",
                                    "message": "选一个方案",
                                    "options": [{"id": "a", "label": "方案A"}],
                                },
                            },
                        }
                    ],
                }
            ]
        )
        created = _post_run(client, "user-a", "session-hitl", "需要选择", "req-hitl")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        paused = _read_sse(
            app,
            f"/v1/agent/runs/{run_id}/events",
            _auth("user-a"),
            lambda text: "hitl.request" in text or "event: run.failed" in text,
        )
        paused_events, _comments = _parse_sse(str(paused["text"]))
        _require(not any(event["event"] == "run.failed" for event in paused_events), paused["text"][:800])
        hitl_events = [
            event
            for event in paused_events
            if event["event"] == "tool.event" and event["data"].get("event_name") == "hitl.request"
        ]
        _require(hitl_events, paused_events)
        _require(not any(event["event"] == "run.completed" for event in paused_events), paused_events)
        _wait_until(lambda: _meta(redis_client, run_id).get("status") == "waiting_hitl", label="HITL 暂停")

        llm.prepare([{"content": "已按方案A继续", "tool_calls": []}])
        resumed = _post_run(client, "user-a", "session-hitl", "方案A", "req-hitl-reply")
        _require(resumed.status_code == 202, resumed.text)
        resumed_id = str(resumed.json()["run_id"])
        _require(resumed_id != run_id, resumed.text)
        _wait_until(lambda: len(llm.calls) >= 1, label="HITL 后续 loop")
        tool_messages = [item for item in llm.calls[0]["messages"] if item.get("role") == "tool"]
        _require(any(item.get("content") == "方案A" for item in tool_messages), llm.calls[0]["messages"])
        assistant_calls = [
            item for item in llm.calls[0]["messages"] if item.get("role") == "assistant" and item.get("tool_calls")
        ]
        _require(assistant_calls, llm.calls[0]["messages"])
        continued = _read_sse(
            app,
            f"/v1/agent/runs/{resumed_id}/events",
            _auth("user-a"),
            lambda text: "event: run.completed" in text or "event: run.failed" in text,
        )
        continued_events, _continued_comments = _parse_sse(str(continued["text"]))
        _require(any(event["event"] == "run.completed" for event in continued_events), continued["text"][:800])
        _require(
            any(
                event["event"] == "chat.message.delta" and event["data"].get("text") == "已按方案A继续"
                for event in continued_events
            ),
            continued_events,
        )
        return {
            10: f"tool.event=hitl.request tool_call_id={hitl_events[0]['data'].get('tool_call_id')}",
            11: f"下一条消息注入 tool result=方案A，继续 run_id={resumed_id}",
        }

    def check_workflow() -> dict[int, str]:
        llm.prepare([{"content": "节点已更新", "tool_calls": []}], hold=True)
        created = _post_run(client, "user-a", "session-workflow", "看节点", "req-workflow")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        try:
            _wait_until(lambda: _meta(redis_client, run_id).get("status") == "running", label="workflow run")
            _append(
                redis_client,
                run_id,
                "workflow.node_status",
                {"node_id": "node-1", "status": "running", "run_id": "wf-1", "outputs": [{"text": "草图"}]},
            )
            llm.hold = False
            llm.release.set()
            live = _read_sse(
                app,
                f"/v1/agent/runs/{run_id}/events",
                _auth("user-a"),
                lambda text: "event: run.completed" in text or "event: run.failed" in text,
            )
        finally:
            llm.hold = False
            llm.release.set()
        events, _comments = _parse_sse(str(live["text"]))
        names = [event["event"] for event in events]
        _require("run.failed" not in names, live["text"][:800])
        _require("workflow.node_status" in names and names.index("workflow.node_status") < names.index("run.completed"), names)
        node_event = next(event for event in events if event["event"] == "workflow.node_status")
        _require(node_event["data"].get("node_id") == "node-1", node_event)
        return {12: "SSE 带上 workflow.node_status node-1，并且排在 run.completed 之前"}

    def check_refresh() -> dict[int, str]:
        llm.prepare([{"content": "刷新后续上", "tool_calls": []}], hold=True)
        created = _post_run(client, "user-a", "session-refresh", "还在跑", "req-refresh")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        try:
            _wait_until(lambda: _meta(redis_client, run_id).get("status") == "running", label="刷新前的 active run")
            listed = client.get("/v1/agent/sessions/session-refresh/active-run", headers=_auth("user-a"))
            _require(listed.status_code == 200, listed.text)
            _require(listed.json().get("run_id") == run_id, listed.text)
            llm.hold = False
            llm.release.set()
            live = _read_sse(
                app,
                f"/v1/agent/runs/{run_id}/events",
                _auth("user-a"),
                lambda text: "event: run.completed" in text or "event: run.failed" in text,
            )
        finally:
            llm.hold = False
            llm.release.set()
        events, _comments = _parse_sse(str(live["text"]))
        _require(any(event["event"] == "run.completed" for event in events), live["text"][:800])
        return {14: f"active-run={run_id}，继续订阅后收到 run.completed"}

    def check_expired() -> dict[int, str]:
        run_id = _seed_run(redis_client, "user-a", "session-expired", "req-expired")
        _append(redis_client, run_id, "chat.message.delta", {"text": "旧事件"})
        redis_client.streams[RedisRunStore.stream_key(run_id)] = [
            ("20-0", {"event": "run.completed", "data": "{}"})
        ]
        response = client.get(
            f"/v1/agent/runs/{run_id}/events",
            headers={**_auth("user-a"), "Last-Event-ID": "1-0"},
        )
        _require(response.status_code == 410, response.text)
        _require(_code(response) == "RESUME_WINDOW_EXPIRED", response.text)
        return {16: "Last-Event-ID=1-0 早于 20-0，410 RESUME_WINDOW_EXPIRED"}

    def check_cancel() -> dict[int, str]:
        llm.prepare([{"content": "不应该继续", "tool_calls": []}], hold=True)
        created = _post_run(client, "user-a", "session-cancel", "取消我", "req-cancel")
        _require(created.status_code == 202, created.text)
        run_id = str(created.json()["run_id"])
        try:
            _wait_until(lambda: len(llm.calls) == 1, label="取消前的 loop")
            live: dict[str, Any] = {"text": "", "status": None, "content_type": ""}

            def _follow_cancel() -> None:
                try:
                    _read_sse(
                        app,
                        f"/v1/agent/runs/{run_id}/events",
                        _auth("user-a"),
                        lambda text: "event: run.cancelled" in text or "event: run.failed" in text,
                        box=live,
                    )
                except Exception as exc:
                    live["error"] = exc

            follower = threading.Thread(target=_follow_cancel, daemon=True)
            follower.start()
            _wait_until(lambda: "agent.started" in str(live.get("text", "")), label="取消前的 SSE")
            cancelled = client.post(f"/v1/agent/runs/{run_id}/cancel", headers=_auth("user-a"))
            _require(cancelled.status_code == 200, cancelled.text)
            _require(cancelled.json().get("cancelled") is True, cancelled.text)
            follower.join(8)
            _require(not follower.is_alive(), live.get("text", "")[:400])
            if live.get("error"):
                raise live["error"]
        finally:
            llm.hold = False
            llm.release.set()
        events, _comments = _parse_sse(str(live["text"]))
        _require(any(event["event"] == "run.cancelled" for event in events), live["text"][:800])
        idle = client.get("/v1/agent/sessions/session-cancel/active-run", headers=_auth("user-a"))
        _require(idle.json().get("run_id") in {None, ""}, idle.text)

        llm.prepare([{"content": "也不应该出现", "tool_calls": []}], hold=True)
        try:
            marked = client.post(
                "/v1/agent/runs/cancel-by-request",
                headers=_auth("user-a"),
                json={"session_id": "session-cancel-request", "client_request_id": "req-cancel-early"},
            )
            _require(marked.status_code == 200, marked.text)
            early = _post_run(client, "user-a", "session-cancel-request", "来不及了", "req-cancel-early")
            _require(early.status_code == 202, early.text)
            early_id = str(early.json()["run_id"])
            _wait_until(lambda: _meta(redis_client, early_id).get("status") == "cancelled", label="cancel-by-request")
            _require(llm.calls == [], llm.calls)
        finally:
            llm.hold = False
            llm.release.set()
        return {17: f"cancel 结束 {run_id}；cancel-by-request 在 loop 调用 LLM 前取消"}

    def check_legacy() -> dict[int, str]:
        response = client.post("/v1/agent/chat", json={"message": "hi", "session_id": "legacy"})
        empty = client.post("/v1/agent/chat", json={})
        _require(response.status_code == 410, response.text)
        _require(empty.status_code == 410, empty.text)
        _require(response.json().get("code") == "USE_AGENT_RUNS", response.text)
        _require(empty.json().get("code") == "USE_AGENT_RUNS", empty.text)
        return {18: "POST /v1/agent/chat 返回 410 USE_AGENT_RUNS"}

    try:
        _guard(results, (1,), check_unauth)
        _guard(results, (2,), check_validation)
        _guard(results, (3, 4), check_idempotent_and_conflict)
        _guard(results, (5,), check_owner)
        _guard(results, (6, 7), check_content_type_and_heartbeat)
        _guard(results, (8, 13, 15), check_text_replay)
        _guard(results, (9,), check_tools)
        _guard(results, (10, 11), check_hitl)
        _guard(results, (12,), check_workflow)
        _guard(results, (14,), check_refresh)
        _guard(results, (16,), check_expired)
        _guard(results, (17,), check_cancel)
        _guard(results, (18,), check_legacy)
        try:
            _apply_frontend(results)
        except Exception as exc:
            message = f"前端验收没有跑起来: {_format_error(exc)}"
            for step in _CLIENT_STEPS:
                item = results[step - 1]
                item["ok"] = False
                item["detail"] = _join(item["detail"], message)
    finally:
        llm.hold = False
        llm.release.set()
        AgentLoop.run = _ORIGINAL_AGENT_RUN  # type: ignore[method-assign]
        DEFAULT_AGENT_FACTORY.build = _ORIGINAL_AGENT_BUILD  # type: ignore[method-assign]
        client_context.__exit__(None, None, None)

    for item in results:
        if item["ok"] and not item["detail"]:
            item["ok"] = False
            item["detail"] = "这一步没有产生验收结果"
    return results


def main() -> int:
    logging.disable(logging.CRITICAL)

    def _on_alarm(_signum: int, _frame: Any) -> None:
        raise SystemExit("验收超过 120 秒，Agent SSE 步骤可能卡住了")

    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(120)
    results = _run(FakeDatabase(), FakeRedis(), ScriptedLlm())
    signal.alarm(0)
    passed = sum(1 for item in results if item["ok"])
    for item in results:
        mark = "通过" if item["ok"] else "失败"
        detail = str(item["detail"]).replace("\n", " ")
        print(f"{mark} {item['step']:02d} {item['name']} — {detail}")
    print(f"闭环 {passed}/{len(results)}。幂等、互斥、SSE、HITL、取消、刷新恢复和旧入口都要通过。")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
