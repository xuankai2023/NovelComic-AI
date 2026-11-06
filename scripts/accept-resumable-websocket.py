#!/usr/bin/env python3
"""按可恢复 WebSocket 的 14 条验收顺序，打服务端协议和前端 transport。

用法：
  novelcomic-publisher/.venv/bin/python scripts/accept-resumable-websocket.py
"""

from __future__ import annotations

import asyncio
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
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

from app.config import get_settings  # noqa: E402
from app.controller.v2 import flow_runs as flow_runs_api  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.workflow_event_store import WorkflowEventStore  # noqa: E402

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_CLIENT_STEPS = (7, 9, 10, 12, 13, 14)
_STEP_TITLES = [
    "未发 auth 首帧，WebSocket 在超时后关闭",
    "JWT 无效，服务端关闭 4401",
    "JWT 有效但 run 不属于当前用户，服务端关闭 4404",
    "auth 成功后收到 authenticated",
    "attach cursor 无效，服务端关闭 4400",
    "attach 合法后，服务端先 replay cursor 后面的旧事件",
    "replay 完成后收到 resume_ready，前端才显示 connected",
    "live 阶段新事件能继续推到前端",
    "handler 成功后才保存 cursor；handler 抛错不推进 cursor",
    "刷新页面后，前端查询 active run，并用 cursor 补回断线期间的事件",
    "同一个 flow_task_id + connection_id 开新连接，旧连接退出",
    "心跳超时会重连；离线时不疯狂重试；恢复在线后能继续 attach",
    "同一 event_id replay 多次，节点状态不乱，副作用不会重复触发",
    "cursor 过期时不会无限重连，会进入明确恢复失败或 reset 流程",
]


def _token(sub: str) -> str:
    encoded = jwt.encode({"sub": sub, "exp": int(time.time()) + 3600}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


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


def _cursor_parts(value: str) -> tuple[int, int]:
    left, right = str(value).split("-", 1)
    return int(left), int(right)


def _after_cursor(message_id: str, minimum: str) -> bool:
    if minimum in {"-", "0-0"}:
        return True
    exclusive = minimum.startswith("(")
    bound = minimum[1:] if exclusive else minimum
    if exclusive:
        return _cursor_parts(message_id) > _cursor_parts(bound)
    return _cursor_parts(message_id) >= _cursor_parts(bound)


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs
        self._iter = iter(docs)

    def sort(self, key: str, direction: int) -> FakeCursor:
        self.docs.sort(key=lambda item: item.get(key) or "", reverse=direction < 0)
        self._iter = iter(self.docs)
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

    @staticmethod
    def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
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
    def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
        copied = dict(document)
        if not projection:
            return copied
        for key, include in projection.items():
            if include == 0:
                copied.pop(key, None)
        return copied

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(document)

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if self._matches(document, query):
                return self._project(document, projection)
        return None

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        matched = [
            self._project(document, projection)
            for document in self.docs
            if self._matches(document, query)
        ]
        return FakeCursor(matched)


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeRedis:
    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.values: dict[str, str] = {}
        self.sequence = 0

    async def eval(self, script: str, numkeys: int, *args: Any) -> list[str]:
        del script
        keys = args[:numkeys]
        argv = args[numkeys:]
        stream_key, dedupe_key = str(keys[0]), str(keys[1])
        event_id = str(argv[0])
        event_json = str(argv[1])
        dedupe = self.hashes.setdefault(dedupe_key, {})
        existing = dedupe.get(event_id)
        if existing is not None:
            return [existing, "0"]
        self.sequence += 1
        cursor = f"{self.sequence}-0"
        self.streams.setdefault(stream_key, []).append(
            (cursor, {"event_id": event_id, "event": event_json})
        )
        dedupe[event_id] = cursor
        return [cursor, "1"]

    async def xrange(
        self,
        stream_key: str,
        min: str = "-",
        max: str = "+",
        count: int | None = None,
    ) -> list[tuple[str, dict[str, str]]]:
        del max
        entries = [
            (entry_id, fields)
            for entry_id, fields in self.streams.get(stream_key, [])
            if _after_cursor(entry_id, min)
        ]
        if count is not None:
            return entries[:count]
        return entries

    async def xread(
        self,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> list[Any]:
        del block
        rows: list[Any] = []
        for stream_key, cursor in streams.items():
            entries = [
                (entry_id, fields)
                for entry_id, fields in self.streams.get(stream_key, [])
                if _cursor_parts(entry_id) > _cursor_parts(str(cursor))
            ]
            if count is not None:
                entries = entries[:count]
            if entries:
                rows.append((stream_key, entries))
        return rows

    async def incr(self, key: str) -> int:
        value = int(self.values.get(key, "0")) + 1
        self.values[key] = str(value)
        return value

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def expire(self, key: str, ttl: int) -> bool:
        del key, ttl
        return True


class FakeConnections:
    def __init__(self, database: FakeDatabase, redis_client: FakeRedis) -> None:
        self.mongo = {"novelcomic": database}
        self.redis = redis_client

    async def close(self) -> None:
        return None


def _seed_run(
    database: FakeDatabase,
    *,
    flow_task_id: str,
    user_id: str,
    flow_id: str = "flow-1",
    status: str = "running",
) -> None:
    database["flow_task"].docs.append(
        {
            "created_at": datetime.now(UTC),
            "flow_id": flow_id,
            "flow_run_id": f"run-{flow_task_id}",
            "flow_task_id": flow_task_id,
            "idempotent_replay": False,
            "protocol_version": 2,
            "status": status,
            "trace_id": f"trace-{flow_task_id}",
            "user_id": user_id,
        }
    )


def _append_event(
    database: FakeDatabase,
    redis_client: FakeRedis,
    flow_task_id: str,
    event_id: str,
    *,
    status: str = "running",
) -> dict[str, Any]:
    async def _write() -> dict[str, Any]:
        return await WorkflowEventStore.append_event(
            database,
            flow_task_id,
            redis_client=redis_client,
            event={
                "event_id": event_id,
                "event_type": "node_status",
                "flow_task_id": flow_task_id,
                "payload": {"node_id": "n1", "status": status},
                "protocol_version": 2,
            },
        )

    return asyncio.run(_write())


def _next_frame(ws: Any, timeout: float) -> Any:
    box: dict[str, Any] = {}

    def _read() -> None:
        try:
            box["frame"] = ws.receive_json()
        except Exception as exc:
            box["error"] = exc

    thread = threading.Thread(target=_read, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise AssertionError(f"{timeout:g}s 内没有收到下一帧")
    if "error" in box:
        return box["error"]
    return box["frame"]


def _frame(ws: Any, timeout: float = 8) -> dict[str, Any]:
    item = _next_frame(ws, timeout)
    if isinstance(item, Exception):
        raise item
    return item


def _expect_close(ws: Any, code: int, timeout: float = 8) -> dict[str, Any] | None:
    first = _next_frame(ws, timeout)
    if isinstance(first, WebSocketDisconnect):
        _require(first.code == code, f"关闭码是 {first.code}，期望 {code}")
        return None
    if isinstance(first, Exception):
        raise first
    second = _next_frame(ws, timeout)
    if isinstance(second, WebSocketDisconnect):
        _require(
            second.code == code,
            f"先收到 {first.get('event_type')}，随后关闭码是 {second.code}，期望 {code}",
        )
        return first
    raise AssertionError(f"期望关闭 {code}，实际又收到 {second}")


def _events_path(flow_task_id: str, connection_id: str) -> str:
    return f"/api/v2/flow/runs/{flow_task_id}/events/{connection_id}"


def _authenticate(ws: Any, token: str) -> dict[str, Any]:
    ws.send_json({"event_type": "auth", "protocol_version": 2, "token": token})
    frame = _frame(ws)
    _require(frame.get("event_type") == "authenticated", frame)
    return frame


def _attach(ws: Any, flow_task_id: str, cursor: str | None) -> None:
    ws.send_json(
        {
            "event_type": "attach_flow",
            "flow_task_id": flow_task_id,
            "last_event_cursor": cursor,
            "protocol_version": 2,
        }
    )


def _until_terminal(ws: Any, timeout: float = 8) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    while len(frames) < 8:
        frame = _frame(ws, timeout)
        frames.append(frame)
        if frame.get("event_type") in {"resume_ready", "resume_error"}:
            return frames
    raise AssertionError(f"8 帧内没有 resume_ready / resume_error: {frames}")


def _event_ids(frames: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for frame in frames:
        event = frame.get("event")
        if isinstance(event, dict) and event.get("event_id"):
            ids.append(str(event["event_id"]))
    return ids


def _run_vitest() -> list[dict[str, Any]]:
    vitest = ROOT / "novelcomic-frontend" / "node_modules" / ".bin" / "vitest"
    _require(vitest.exists(), f"找不到前端 vitest: {vitest}")
    descriptor, name = tempfile.mkstemp(prefix="accept-resumable-ws-", suffix=".json")
    os.close(descriptor)
    report = Path(name)
    try:
        completed = subprocess.run(
            [
                str(vitest),
                "run",
                "src/lib/accept-resumable-websocket.test.ts",
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


def _run(database: FakeDatabase, redis_client: FakeRedis) -> list[dict[str, Any]]:
    settings = get_settings()
    settings.clerk_pem_public_key = _PUBLIC_PEM
    settings.mongo_database = "novelcomic"
    owner = "user_ws_owner"
    owner_token = _token(owner)
    other_token = _token("user_ws_other")

    connections = FakeConnections(database, redis_client)

    @asynccontextmanager
    async def _lifespan(app: Any) -> Any:
        app.state.connections = connections
        yield

    app = create_app()
    app.router.lifespan_context = _lifespan
    app.state.connections = connections
    client = TestClient(app)
    results = [
        {"step": index, "name": title, "ok": True, "detail": ""}
        for index, title in enumerate(_STEP_TITLES, start=1)
    ]

    def check_auth_timeout() -> dict[int, str]:
        _require(flow_runs_api._WS_AUTH_TIMEOUT_SECONDS == 15, "auth 等待时间不是 15 秒")
        started = time.monotonic()
        with client.websocket_connect(_events_path("task-no-auth", "conn-no-auth")) as ws:
            frame = _expect_close(ws, 4401, timeout=18)
        elapsed = time.monotonic() - started
        _require(elapsed >= 14, f"连接 {elapsed:.1f}s 就关了，不像 15 秒 auth 超时")
        _require(frame is not None and frame.get("code") == "AUTH_REQUIRED", frame)
        return {1: f"close=4401，AUTH_REQUIRED，耗时 {elapsed:.1f}s"}

    def check_invalid_jwt() -> dict[int, str]:
        _seed_run(database, flow_task_id="task-bad-jwt", user_id=owner)
        with client.websocket_connect(_events_path("task-bad-jwt", "conn-bad-jwt")) as ws:
            ws.send_json({"event_type": "auth", "protocol_version": 2, "token": "not-a-jwt"})
            frame = _expect_close(ws, 4401)
        _require(frame is not None and frame.get("code") == "AUTH_FAILED", frame)
        return {2: "close=4401，AUTH_FAILED"}

    def check_foreign_run() -> dict[int, str]:
        _seed_run(database, flow_task_id="task-foreign", user_id=owner)
        with client.websocket_connect(_events_path("task-foreign", "conn-foreign")) as ws:
            ws.send_json({"event_type": "auth", "protocol_version": 2, "token": other_token})
            frame = _expect_close(ws, 4404)
        _require(frame is not None and frame.get("code") == "RUN_NOT_FOUND", frame)
        return {3: "close=4404，RUN_NOT_FOUND"}

    def check_authenticated() -> dict[int, str]:
        _seed_run(database, flow_task_id="task-auth", user_id=owner)
        with client.websocket_connect(_events_path("task-auth", "conn-auth")) as ws:
            frame = _authenticate(ws, owner_token)
        _require(frame.get("flow_task_id") == "task-auth", frame)
        return {4: "event_type=authenticated"}

    def check_invalid_cursor() -> dict[int, str]:
        _seed_run(database, flow_task_id="task-bad-cursor", user_id=owner)
        with client.websocket_connect(_events_path("task-bad-cursor", "conn-bad-cursor")) as ws:
            _authenticate(ws, owner_token)
            _attach(ws, "task-bad-cursor", "not-a-cursor")
            frame = _expect_close(ws, 4400)
        _require(frame is not None and frame.get("code") == "INVALID_CURSOR", frame)
        return {5: "close=4400，INVALID_CURSOR"}

    def check_replay_then_ready() -> dict[int, str]:
        flow_task_id = "task-replay"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner)
        cursors = [
            _append_event(database, redis_client, flow_task_id, event_id)["cursor"]
            for event_id in ("evt-1", "evt-2", "evt-3")
        ]
        with client.websocket_connect(_events_path(flow_task_id, "conn-replay")) as ws:
            _authenticate(ws, owner_token)
            _attach(ws, flow_task_id, cursors[1])
            frames = _until_terminal(ws)
        ids = _event_ids(frames)
        _require(ids == ["evt-3"], f"cursor {cursors[1]} 之后应该只有 evt-3，实际 {ids}")
        _require(all(frame.get("replayed") is True for frame in frames if frame.get("event")), frames)
        _require(frames[-1].get("event_type") == "resume_ready", frames)
        _require(frames[-1].get("cursor") == cursors[2], frames[-1])
        return {
            6: f"cursor={cursors[1]} replay={ids}",
            7: f"顺序={' -> '.join(ids + ['resume_ready'])}",
        }

    def check_live_event() -> dict[int, str]:
        flow_task_id = "task-live"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner)
        old = _append_event(database, redis_client, flow_task_id, "evt-old")
        with client.websocket_connect(_events_path(flow_task_id, "conn-live")) as ws:
            _authenticate(ws, owner_token)
            _attach(ws, flow_task_id, None)
            replayed = _until_terminal(ws)
            _require(_event_ids(replayed) == ["evt-old"], replayed)
            _require(replayed[-1].get("event_type") == "resume_ready", replayed)

            def _append_live() -> None:
                time.sleep(0.2)
                _append_event(database, redis_client, flow_task_id, "evt-live", status="success")

            threading.Thread(target=_append_live, daemon=True).start()
            live = _frame(ws, timeout=8)
        _require(live.get("event_type") == "workflow_event", live)
        _require(live.get("replayed") is False, live)
        _require(isinstance(live.get("event"), dict) and live["event"].get("event_id") == "evt-live", live)
        _require(old["cursor"] != live.get("cursor"), live)
        return {8: "resume_ready 之后收到 evt-live，replayed=false"}

    def check_refresh_gap() -> dict[int, str]:
        flow_id = "flow-refresh"
        flow_task_id = "task-refresh"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner, flow_id=flow_id)
        _seed_run(
            database,
            flow_task_id="task-refresh-done",
            user_id=owner,
            flow_id=flow_id,
            status="success",
        )
        _seed_run(
            database,
            flow_task_id="task-refresh-other",
            user_id="user_ws_other",
            flow_id=flow_id,
        )
        first = _append_event(database, redis_client, flow_task_id, "evt-seen")
        second = _append_event(database, redis_client, flow_task_id, "evt-missed", status="success")
        listed = client.get(
            "/api/v2/flow/runs",
            headers={"Authorization": f"Bearer {owner_token}"},
            params={"flow_id": flow_id, "status": "active"},
        )
        _require(listed.status_code == 200, listed.text)
        active_ids = [item.get("flow_task_id") for item in listed.json()["data"]]
        _require(active_ids == [flow_task_id], active_ids)
        with client.websocket_connect(_events_path(flow_task_id, "conn-refresh")) as ws:
            _authenticate(ws, owner_token)
            _attach(ws, flow_task_id, first["cursor"])
            frames = _until_terminal(ws)
        _require(_event_ids(frames) == ["evt-missed"], frames)
        _require(frames[-1].get("event_type") == "resume_ready", frames)
        _require(frames[-1].get("cursor") == second["cursor"], frames[-1])
        return {10: f"active=[{flow_task_id}]，cursor={first['cursor']} 补回 evt-missed"}

    def check_connection_replaced() -> dict[int, str]:
        flow_task_id = "task-replace"
        connection_id = "conn-replace"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner)
        holder: dict[str, Any] = {}

        def _open_second() -> None:
            try:
                with client.websocket_connect(_events_path(flow_task_id, connection_id)) as second:
                    _authenticate(second, owner_token)
                    _attach(second, flow_task_id, None)
                    frames = _until_terminal(second)
                    _require(frames[-1].get("event_type") == "resume_ready", frames)
                    holder["ready"] = True
            except Exception as exc:
                holder["error"] = exc

        with client.websocket_connect(_events_path(flow_task_id, connection_id)) as first:
            _authenticate(first, owner_token)
            _attach(first, flow_task_id, None)
            ready = _until_terminal(first)
            _require(ready[-1].get("event_type") == "resume_ready", ready)
            thread = threading.Thread(target=_open_second, daemon=True)
            thread.start()
            closed = _expect_close(first, 4001, timeout=8)
            thread.join(8)
        if "error" in holder:
            raise holder["error"]
        _require(holder.get("ready") is True, "新连接没有走到 resume_ready")
        _require(closed is None or closed.get("event_type") != "resume_ready", closed)
        return {11: "旧连接 close=4001，新连接已 resume_ready"}

    def check_duplicate_replay() -> dict[int, str]:
        _require("HGET" in WorkflowEventStore._APPEND_EVENT_SCRIPT, "Event Store 不再按 event_id 去重")
        flow_task_id = "task-dedupe"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner)
        first = _append_event(database, redis_client, flow_task_id, "evt-same")
        second = _append_event(database, redis_client, flow_task_id, "evt-same", status="success")
        _require(first["cursor"] == second["cursor"], (first, second))
        _require(second.get("inserted") is False, second)

        async def _replay() -> list[str]:
            events = await WorkflowEventStore.replay_after(
                database,
                flow_task_id,
                None,
                redis_client=redis_client,
            )
            return [str(event["event_id"]) for event in events]

        _require(asyncio.run(_replay()) == ["evt-same"], "重复 append 后 stream 里不是 1 条")
        seen: list[list[str]] = []
        for index in (1, 2):
            with client.websocket_connect(_events_path(flow_task_id, f"conn-dedupe-{index}")) as ws:
                _authenticate(ws, owner_token)
                _attach(ws, flow_task_id, None)
                seen.append(_event_ids(_until_terminal(ws)))
        _require(seen == [["evt-same"], ["evt-same"]], seen)
        return {13: f"重复 append cursor={first['cursor']}，两次 attach 都只 replay evt-same"}

    def check_expired_cursor() -> dict[int, str]:
        flow_task_id = "task-expired"
        _seed_run(database, flow_task_id=flow_task_id, user_id=owner)
        redis_client.streams[WorkflowEventStore._stream_key(flow_task_id)] = [
            (
                "5-0",
                {
                    "event": json.dumps(
                        {
                            "event_id": "evt-5",
                            "event_type": "node_status",
                            "flow_task_id": flow_task_id,
                            "payload": {"node_id": "n1", "status": "running"},
                            "protocol_version": 2,
                        }
                    )
                },
            )
        ]
        with client.websocket_connect(_events_path(flow_task_id, "conn-expired")) as ws:
            _authenticate(ws, owner_token)
            _attach(ws, flow_task_id, "1-0")
            frame = _expect_close(ws, 4409)
        _require(frame is not None and frame.get("event_type") == "resume_error", frame)
        _require(frame.get("code") == "RESUME_WINDOW_EXPIRED", frame)
        _require(frame.get("reason") == "cursor_expired", frame)
        return {14: "resume_error(cursor_expired) 后 close=4409"}

    try:
        _guard(results, (1,), check_auth_timeout)
        _guard(results, (2,), check_invalid_jwt)
        _guard(results, (3,), check_foreign_run)
        _guard(results, (4,), check_authenticated)
        _guard(results, (5,), check_invalid_cursor)
        _guard(results, (6, 7), check_replay_then_ready)
        _guard(results, (8,), check_live_event)
        _guard(results, (10,), check_refresh_gap)
        _guard(results, (11,), check_connection_replaced)
        _guard(results, (13,), check_duplicate_replay)
        _guard(results, (14,), check_expired_cursor)
        try:
            _apply_frontend(results)
        except Exception as exc:
            message = f"前端验收没有跑起来: {_format_error(exc)}"
            for step in _CLIENT_STEPS:
                item = results[step - 1]
                item["ok"] = False
                item["detail"] = _join(item["detail"], message)
    finally:
        client.close()

    for item in results:
        if item["ok"] and not item["detail"]:
            item["ok"] = False
            item["detail"] = "这一步没有产生验收结果"
    return results


def main() -> int:
    logging.disable(logging.CRITICAL)

    def _on_alarm(_signum: int, _frame: Any) -> None:
        raise SystemExit("验收超过 120 秒，WebSocket 步骤可能卡住了")

    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(120)
    results = _run(FakeDatabase(), FakeRedis())
    signal.alarm(0)
    passed = sum(1 for item in results if item["ok"])
    for item in results:
        mark = "通过" if item["ok"] else "失败"
        detail = str(item["detail"]).replace("\n", " ")
        print(f"{mark} {item['step']:02d} {item['name']} — {detail}")
    print(f"闭环 {passed}/{len(results)}。认证、归属、attach、replay、live、cursor、去重、重连和刷新恢复需要全部通过。")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
