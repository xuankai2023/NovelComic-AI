#!/usr/bin/env python3
"""按「从登录到画布亮灯」的顺序验收，不跳过中间件和消息层。

命令、Redis Stream、Consumer inbox、AI /v1/tasks、outbox、Event Store、
WebSocket 和节点状态必须在同一次进程里接上。只拿到 202，或只连上 WebSocket，都不算通过。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.request import urlopen

import jwt
import uvicorn
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

ROOT = Path(__file__).resolve().parents[1]
_VENV_PYTHON = ROOT / "novelcomic-publisher" / ".venv" / "bin" / "python"
if _VENV_PYTHON.exists() and Path(sys.executable).resolve() != _VENV_PYTHON.resolve():
    if os.environ.get("NOVELCOMIC_ACCEPT_LIGHT_PY") != "1":
        os.environ["NOVELCOMIC_ACCEPT_LIGHT_PY"] = "1"
        os.execv(_VENV_PYTHON, [str(_VENV_PYTHON), *sys.argv])

sys.path.insert(0, str(ROOT / "novelcomic-publisher"))

from app.config import get_settings  # noqa: E402
from app.controller.v2 import flow_runs as flow_runs_api  # noqa: E402
from app.database.mq import workflow_v2_mq_callback  # noqa: E402
from app.main import create_app  # noqa: E402
from app.middleware.auth_middleware import WHITE_LIST  # noqa: E402
from app.services.workflow_event_store import WorkflowEventStore  # noqa: E402
from app.services.workflow_runs_v2 import V2_REPLY_QUEUE_NAME  # noqa: E402
from app.tasks.flow import FlowTask as PublisherFlowTask  # noqa: E402

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)

PROMPT_ID = "prompt"
MODEL_ID = "draw"
NODES = [
    {"id": PROMPT_ID, "type": "textInput", "data": {"label": "Prompt", "text": "一只猫"}},
    {"id": MODEL_ID, "type": "imageModel", "data": {"label": "Draw", "model_id": "seedance-test"}},
]
EDGES = [{"id": "edge-prompt-draw", "source": PROMPT_ID, "target": MODEL_ID}]


def _key_exists(document: dict[str, Any], key: str) -> bool:
    current: Any = document
    for part in str(key).split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return True


def _get_nested(document: dict[str, Any], key: str) -> Any:
    current: Any = document
    for part in str(key).split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_nested(document: dict[str, Any], key: str, value: Any) -> None:
    current = document
    parts = str(key).split(".")
    for part in parts[:-1]:
        nested = current.get(part)
        if not isinstance(nested, dict):
            nested = {}
            current[part] = nested
        current = nested
    current[parts[-1]] = copy.deepcopy(value)


def _unset(document: dict[str, Any], key: str) -> None:
    current: Any = document
    parts = str(key).split(".")
    for part in parts[:-1]:
        if not isinstance(current, dict):
            return
        current = current.get(part)
    if isinstance(current, dict):
        current.pop(parts[-1], None)


def _match_ops(actual: Any, operators: dict[str, Any]) -> bool:
    for operator, expected in operators.items():
        if operator == "$in":
            if actual not in expected:
                return False
        elif operator == "$ne":
            if actual == expected:
                return False
        elif operator == "$gt":
            if actual is None or not actual > expected:
                return False
        elif operator == "$gte":
            if actual is None or not actual >= expected:
                return False
        elif operator == "$lt":
            if actual is None or not actual < expected:
                return False
        elif operator == "$lte":
            if actual is None or not actual <= expected:
                return False
        elif operator == "$exists":
            raise AssertionError("验收脚本应在字段层处理 $exists")
        elif operator == "$type":
            if expected == "object" and not isinstance(actual, dict):
                return False
            if expected == "string" and not isinstance(actual, str):
                return False
        else:
            raise AssertionError(f"验收脚本还不认识查询运算符 {operator}")
    return True


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, item) for item in expected):
                return False
            continue
        if key == "$and":
            if not all(_matches(document, item) for item in expected):
                return False
            continue
        actual = _get_nested(document, key)
        if isinstance(expected, dict) and any(str(item).startswith("$") for item in expected):
            if "$exists" in expected:
                exists = _key_exists(document, key)
                if exists != bool(expected["$exists"]):
                    return False
                rest = {operator: value for operator, value in expected.items() if operator != "$exists"}
                if rest and not _match_ops(actual, rest):
                    return False
                continue
            if not _match_ops(actual, expected):
                return False
            continue
        if actual != expected:
            return False
    return True


def _apply_update(document: dict[str, Any], update: dict[str, Any], *, on_insert: bool) -> None:
    unknown = set(update) - {"$set", "$setOnInsert", "$unset", "$inc"}
    if unknown:
        raise AssertionError(f"验收脚本还不认识更新运算符 {sorted(unknown)}")
    if on_insert:
        for key, value in update.get("$setOnInsert", {}).items():
            _set_nested(document, key, value)
    for key, value in update.get("$set", {}).items():
        _set_nested(document, key, value)
    for key in update.get("$unset", {}):
        _unset(document, key)
    for key, value in update.get("$inc", {}).items():
        current = _get_nested(document, key)
        _set_nested(document, key, (0 if current is None else current) + value)


def _equalities(query: dict[str, Any]) -> dict[str, Any]:
    document: dict[str, Any] = {}
    for key, expected in query.items():
        if key.startswith("$"):
            continue
        if isinstance(expected, dict) and any(str(item).startswith("$") for item in expected):
            continue
        _set_nested(document, key, expected)
    return document


def _sort_value(value: Any) -> tuple[int, Any]:
    if value is None:
        return (0, "")
    if isinstance(value, datetime):
        return (1, value.timestamp())
    return (1, value)


def _sorted_docs(docs: list[dict[str, Any]], sort: Any) -> list[dict[str, Any]]:
    ordered = list(docs)
    if not sort:
        return ordered
    pairs = sort if isinstance(sort, list) else [(sort, 1)]
    for key, direction in reversed(pairs):
        ordered.sort(
            key=lambda document, field=key: _sort_value(_get_nested(document, field)),
            reverse=direction < 0,
        )
    return ordered


def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
    if not projection:
        return document
    projected = dict(document)
    for key, include in projection.items():
        if include == 0:
            projected.pop(key, None)
    return projected


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def sort(self, key: Any, direction: int = 1) -> FakeCursor:
        self.docs = _sorted_docs(self.docs, key if isinstance(key, list) else [(key, direction)])
        return self

    def __aiter__(self) -> Any:
        async def _generator() -> Any:
            for document in self.docs:
                yield document

        return _generator()


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []
        self._seq = 0

    async def insert_one(self, document: dict[str, Any]) -> SimpleNamespace:
        stored = copy.deepcopy(document)
        if "_id" not in stored:
            self._seq += 1
            stored["_id"] = f"oid-{self._seq}"
        elif any(item.get("_id") == stored["_id"] for item in self.docs):
            raise DuplicateKeyError("E11000 duplicate key error")
        self.docs.append(stored)
        return SimpleNamespace(inserted_id=stored["_id"])

    def _select(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        return [document for document in self.docs if _matches(document, query)]

    async def find_one(
        self,
        query: dict[str, Any] | None = None,
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        matched = self._select(query or {})
        if not matched:
            return None
        return _project(copy.deepcopy(matched[0]), projection)

    def find(
        self,
        query: dict[str, Any] | None = None,
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        return FakeCursor(
            [_project(copy.deepcopy(document), projection) for document in self._select(query or {})]
        )

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        upsert: bool = False,
    ) -> SimpleNamespace:
        matched = self._select(query)
        if matched:
            _apply_update(matched[0], update, on_insert=False)
            return SimpleNamespace(matched_count=1, modified_count=1, upserted_id=None)
        if not upsert:
            return SimpleNamespace(matched_count=0, modified_count=0, upserted_id=None)
        document = _equalities(query)
        _apply_update(document, update, on_insert=True)
        if "_id" not in document:
            self._seq += 1
            document["_id"] = f"oid-{self._seq}"
        self.docs.append(document)
        return SimpleNamespace(matched_count=1, modified_count=1, upserted_id=document["_id"])

    async def find_one_and_update(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        sort: Any = None,
        upsert: bool = False,
        return_document: Any = ReturnDocument.BEFORE,
    ) -> dict[str, Any] | None:
        matched = _sorted_docs(self._select(query), sort)
        if matched:
            before = copy.deepcopy(matched[0])
            _apply_update(matched[0], update, on_insert=False)
            if return_document == ReturnDocument.AFTER:
                return copy.deepcopy(matched[0])
            return before
        if not upsert:
            return None
        document = _equalities(query)
        _apply_update(document, update, on_insert=True)
        if "_id" not in document:
            self._seq += 1
            document["_id"] = f"oid-{self._seq}"
        elif any(item.get("_id") == document["_id"] for item in self.docs):
            raise DuplicateKeyError("E11000 duplicate key error")
        self.docs.append(document)
        if return_document == ReturnDocument.AFTER:
            return copy.deepcopy(document)
        return None


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


def _stream_id_parts(value: str) -> tuple[int, int]:
    left, right = value.split("-", 1)
    return int(left), int(right)


def _stream_id_included(message_id: str, minimum: str, maximum: str) -> bool:
    if minimum != "-":
        exclusive = minimum.startswith("(")
        bound = minimum[1:] if exclusive else minimum
        if exclusive:
            if _stream_id_parts(message_id) <= _stream_id_parts(bound):
                return False
        elif _stream_id_parts(message_id) < _stream_id_parts(bound):
            return False
    if maximum != "+":
        exclusive = maximum.startswith("(")
        bound = maximum[1:] if exclusive else maximum
        if exclusive:
            if _stream_id_parts(message_id) >= _stream_id_parts(bound):
                return False
        elif _stream_id_parts(message_id) > _stream_id_parts(bound):
            return False
    return True


class MemoryRedis:
    """给 Publisher / Consumer / Event Store 用的内存 Redis Stream。"""

    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.groups: dict[tuple[str, str], dict[str, Any]] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.seq = 0
        self.sequence = 0
        self.eval_error: BaseException | None = None
        self.allowed_script: str | None = None
        self.values: dict[str, str] = {}

    async def set(
        self,
        key: str,
        value: Any,
        *args: Any,
        ex: int | None = None,
        nx: bool = False,
        **kwargs: Any,
    ) -> bool | None:
        del args, ex, kwargs
        name = self._text(key)
        if nx and name in self.values:
            return None
        self.values[name] = self._text(value)
        return True

    async def get(self, key: str) -> str | None:
        return self.values.get(self._text(key))

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            name = self._text(key)
            if name in self.values:
                del self.values[name]
                removed += 1
        return removed

    def _text(self, value: Any) -> str:
        if isinstance(value, bytes):
            return value.decode()
        return value if isinstance(value, str) else str(value)

    async def xadd(self, name: str, fields: dict[Any, Any], *args: Any, **kwargs: Any) -> str:
        del args, kwargs
        self.seq += 1
        message_id = f"{self.seq}-0"
        encoded = {self._text(key): self._text(value) for key, value in fields.items()}
        self.streams.setdefault(name, []).append((message_id, encoded))
        return message_id

    async def xrange(self, name: str, min: str = "-", max: str = "+") -> list[tuple[str, dict[str, str]]]:
        return [
            (message_id, fields)
            for message_id, fields in self.streams.get(name, [])
            if _stream_id_included(message_id, min, max)
        ]

    async def xgroup_create(self, name: str, group: str, id: str = "0", mkstream: bool = False) -> None:
        if mkstream:
            self.streams.setdefault(name, [])
        key = (name, group)
        if key in self.groups:
            raise RuntimeError("BUSYGROUP Consumer Group name already exists")
        self.groups[key] = {"acked": set(), "pending": {}, "start": id}

    async def xreadgroup(
        self,
        group: str,
        consumer: str,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> list[tuple[str, list[tuple[str, dict[str, str]]]]]:
        output: list[tuple[str, list[tuple[str, dict[str, str]]]]] = []
        for name, offset in streams.items():
            if offset != ">":
                raise AssertionError(f"验收脚本只消费新消息，收到 offset={offset}")
            state = self.groups[(name, group)]
            entries: list[tuple[str, dict[str, str]]] = []
            for message_id, fields in self.streams.get(name, []):
                if message_id in state["acked"] or message_id in state["pending"]:
                    continue
                state["pending"][message_id] = consumer
                entries.append((message_id, fields))
                if count is not None and len(entries) >= count:
                    break
            if entries:
                output.append((name, entries))
        if output or not block:
            return output
        await asyncio.sleep(0.01)
        return []

    async def xack(self, name: str, group: str, *message_ids: str) -> int:
        state = self.groups[(name, group)]
        acked = 0
        for message_id in message_ids:
            if message_id in state["pending"]:
                state["pending"].pop(message_id, None)
                state["acked"].add(message_id)
                acked += 1
        return acked

    async def xread(
        self,
        streams: dict[str, str],
        count: int | None = None,
        block: int | None = None,
    ) -> list[tuple[str, list[tuple[str, dict[str, str]]]]]:
        output: list[tuple[str, list[tuple[str, dict[str, str]]]]] = []
        for name, last_id in streams.items():
            entries = [
                (message_id, fields)
                for message_id, fields in self.streams.get(name, [])
                if _stream_id_parts(message_id) > _stream_id_parts(str(last_id))
            ]
            if count is not None:
                entries = entries[:count]
            if entries:
                output.append((name, entries))
        if output or not block:
            return output
        await asyncio.sleep(0.05)
        return []

    async def eval(self, script: str, numkeys: int, *keys_and_args: str) -> list[str]:
        if self.allowed_script is not None and script != self.allowed_script:
            raise RuntimeError("Event Store 的 Lua 脚本变了，验收用的 Redis 不能假装执行")
        if self.eval_error is not None:
            error = self.eval_error
            self.eval_error = None
            raise error
        keys = list(keys_and_args[:numkeys])
        args = list(keys_and_args[numkeys:])
        event_id = str(args[0])
        event_json = str(args[1])
        flow_task_id = str(args[2]) if len(args) > 2 else ""
        dedupe = self.hashes.setdefault(str(keys[1]), {})
        existing = dedupe.get(event_id)
        if existing is not None:
            return [existing, "0"]
        self.sequence += 1
        cursor = f"{self.sequence}-0"
        self.streams.setdefault(str(keys[0]), []).append(
            (cursor, {"event_id": event_id, "event": event_json})
        )
        dedupe[event_id] = cursor
        if len(keys) > 2:
            self.streams.setdefault(str(keys[2]), []).append(
                (
                    f"{self.sequence}-1",
                    {
                        "cursor": cursor,
                        "event_id": event_id,
                        "flow_task_id": flow_task_id,
                    },
                )
            )
        return [cursor, "1"]

    async def aclose(self) -> None:
        return None


class FakeConnections:
    def __init__(self, database: FakeDatabase, redis_client: MemoryRedis) -> None:
        self.mongo = FakeMongo(database)
        self.redis = redis_client

    async def close(self) -> None:
        return None


class RecordingMessage:
    def __init__(self, body: bytes, order: list[str]) -> None:
        self.body = body
        self.order = order
        self.actions: list[str] = []

    async def ack(self) -> None:
        self.actions.append("ack")
        self.order.append("ack")

    async def nack(self, requeue: bool = True) -> None:
        self.actions.append(f"nack:{requeue}")
        self.order.append("nack")

    async def reject(self, requeue: bool = False) -> None:
        self.actions.append(f"reject:{requeue}")
        self.order.append("nack")


class _AiDependencies:
    def __init__(self, mongo: FakeMongo) -> None:
        self.mongo = mongo

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def check_all(self) -> dict[str, dict[str, str]]:
        return {
            "mongodb": {"status": "ok"},
            "redis": {"status": "ok"},
            "rabbitmq": {"status": "ok"},
        }


def _load_consumer() -> dict[str, Any]:
    publisher_root = str(ROOT / "novelcomic-publisher")
    consumer_root = str(ROOT / "novelcomic-consumer")
    stashed = {
        key: sys.modules.pop(key)
        for key in list(sys.modules)
        if key == "app" or key.startswith("app.")
    }
    sys.path[:] = [item for item in sys.path if item != publisher_root]
    sys.path.insert(0, consumer_root)
    try:
        import app.config as consumer_config
        import app.services.workflow.flow_event_publish_service as publish_module
        import app.tasks.flow as flow_module

        held = {
            key: sys.modules[key]
            for key in list(sys.modules)
            if key == "app" or key.startswith("app.")
        }
        return {
            "config": consumer_config,
            "flow": flow_module,
            "held": held,
            "publish": publish_module,
        }
    finally:
        sys.path[:] = [item for item in sys.path if item != consumer_root]
        for key in list(sys.modules):
            if key == "app" or key.startswith("app."):
                sys.modules.pop(key, None)
        sys.modules.update(stashed)
        sys.path.insert(0, publisher_root)


def _token(sub: str) -> str:
    encoded = jwt.encode({"sub": sub, "exp": int(time.time()) + 3600}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _check(results: list[dict[str, Any]], step: int, name: str, fn: Any) -> None:
    try:
        detail = fn()
        results.append({"step": step, "name": name, "ok": True, "detail": detail or "ok"})
    except Exception as exc:
        if isinstance(exc, AssertionError):
            detail = str(exc)
        else:
            detail = "".join(traceback.format_exception(exc)).strip()
        results.append({"step": step, "name": name, "ok": False, "detail": detail})


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _install_fast_websocket_wait() -> None:
    async def _stop_after_replay(
        websocket: Any,
        *,
        database: Any,
        redis_client: Any,
        flow_task_id: str,
        cursor: str | None,
    ) -> None:
        del websocket, database, redis_client, flow_task_id, cursor
        return None

    # attach 时的 replay / resume_ready 已经发生。测试客户端关掉连接后，
    # 原来的 _event_loop 还会继续心跳，下一次连接会接到已经关闭的流。
    flow_runs_api._event_loop = _stop_after_replay


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_until(predicate: Any, timeout: float, message: str) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(message)


def _start_ai_server(database: FakeDatabase) -> tuple[str, list[tuple[str, str]], uvicorn.Server, threading.Thread]:
    sys.path.insert(0, str(ROOT / "novelcomic-agent" / "src"))
    from novelcomic_agent.config import Settings
    from novelcomic_agent.main import create_app as create_ai_app

    paths: list[tuple[str, str]] = []
    ai_app = create_ai_app(
        Settings(mongodb_database="novelcomic", dependency_timeout_seconds=0.2),
        dependency_manager=_AiDependencies(FakeMongo(database)),
    )

    @ai_app.middleware("http")
    async def _record_ai_request(request: Any, call_next: Any) -> Any:
        paths.append((request.method, request.url.path))
        return await call_next(request)

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(ai_app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    )
    thread = threading.Thread(target=lambda: asyncio.run(server._serve()), name="accept-ai", daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    _wait_until(lambda: server.started or not thread.is_alive(), 8, f"AI /v1/tasks 没有在 {base} 起来")
    _require(server.started, f"AI 服务启动失败: {base}")
    with urlopen(f"{base}/health", timeout=2) as response:
        _require(response.status == 200, f"AI /health 状态是 {response.status}")
    return base, paths, server, thread


def _run_body(client: TestClient, headers: dict[str, str], command_id: str, flow_id: str) -> dict[str, Any]:
    return {
        "client_request_id": command_id,
        "command_id": command_id,
        "end_ids": [MODEL_ID],
        "flow_id": flow_id,
        "flow_task": {"edges": EDGES, "nodes": NODES},
        "run_mode": "global",
        "start_ids": [PROMPT_ID],
    }


def _stream_payloads(redis_client: MemoryRedis, decoder: Any) -> list[dict[str, Any]]:
    async def _read() -> list[dict[str, Any]]:
        entries = await redis_client.xrange(PublisherFlowTask.run_flow.queue_name)
        return [decoder(fields) for _message_id, fields in entries]

    return asyncio.run(_read())


def _consume_once(worker: Any, redis_client: MemoryRedis) -> int:
    async def _drain() -> int:
        await worker._ensure_group()
        messages = await redis_client.xreadgroup(
            worker.GROUP,
            worker.consumer_name,
            {worker.STREAM: ">"},
            count=10,
            block=0,
        )
        handled = 0
        for _stream_name, entries in messages:
            for message_id, fields in entries:
                await worker._handle_message(message_id, fields)
                handled += 1
        return handled

    return asyncio.run(_drain())


_WS_SEQ = 0


def _websocket_frames(
    client: TestClient,
    flow_task_id: str,
    token: str,
    *,
    cursor: str | None = None,
    first_frame: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    global _WS_SEQ
    _WS_SEQ += 1
    frames: list[dict[str, Any]] = []
    socket_manager = client.websocket_connect(
        f"/api/v2/flow/runs/{flow_task_id}/events/accept-{_WS_SEQ}"
    )
    websocket = socket_manager.__enter__()
    try:
        if first_frame is not None:
            websocket.send_json(first_frame)
        else:
            websocket.send_json({"event_type": "auth", "protocol_version": 2, "token": token})
            frames.append(websocket.receive_json())
            if frames[-1].get("event_type") == "error":
                return frames
            websocket.send_json(
                {
                    "event_type": "attach_flow",
                    "flow_task_id": flow_task_id,
                    "last_event_cursor": cursor,
                    "protocol_version": 2,
                }
            )
        while len(frames) < 8:
            frame = websocket.receive_json()
            frames.append(frame)
            if frame.get("event_type") in {"error", "resume_ready"}:
                break
    finally:
        try:
            socket_manager.__exit__(None, None, None)
        except Exception:
            pass
    return frames


def _logical_events(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for frame in frames:
        if frame.get("event_type") == "replay":
            events.extend(frame.get("events") or [])
            continue
        event = frame.get("event")
        if isinstance(event, dict):
            events.append(event)
            continue
        if frame.get("event_type") not in {"authenticated", "heartbeat", "resume_ready"}:
            events.append(frame)
    return events


def _reduce_canvas(events: list[dict[str, Any]]) -> dict[str, list[str]]:
    history = {PROMPT_ID: ["idle"], MODEL_ID: ["idle"]}

    def set_status(node_id: Any, status: str) -> None:
        if node_id not in history:
            return
        history[str(node_id)].append(status)

    for event in events:
        event_type = str(event.get("event_type") or event.get("event") or "")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        node_id = payload.get("node_id") or event.get("node_id")
        if event_type == "start_flow":
            for node_id in history:
                set_status(node_id, "ready")
            continue
        if event_type == "llm_model_ready":
            set_status(node_id, "running")
            continue
        if event_type != "node_status":
            continue
        status = str(payload.get("status") or event.get("status") or "").lower()
        if status == "completed":
            status = "success"
        if status in {"running", "success", "failed", "idle", "ready", "pause", "select"}:
            set_status(node_id, status)
    return history


def _assert_ack_order(order: list[str]) -> None:
    pending_success = 0
    for item in order:
        if item == "append_ok":
            pending_success += 1
        elif item == "ack":
            _require(pending_success > 0, f"ACK 出现在 append_event() 成功之前: {order}")
            pending_success -= 1
        elif item == "append_fail":
            _require(pending_success == 0, f"append_event() 失败前有未配对的成功写入: {order}")
        elif item == "nack":
            _require(pending_success == 0, f"append_event() 失败后仍然可以 ACK: {order}")


def _run(database: FakeDatabase, redis_client: MemoryRedis) -> list[dict[str, Any]]:
    settings = get_settings()
    settings.clerk_pem_public_key = _PUBLIC_PEM
    settings.mongo_database = "novelcomic"
    redis_client.allowed_script = WorkflowEventStore._APPEND_EVENT_SCRIPT
    _install_fast_websocket_wait()

    consumer = _load_consumer()
    consumer_settings = consumer["config"].get_settings()
    ai_base, ai_paths, ai_server, ai_thread = _start_ai_server(database)
    consumer_settings.oc_api_url = ai_base
    consumer_settings.ai_submit_timeout_seconds = 5

    claim_results: list[bool] = []
    queue_log: list[dict[str, Any]] = []
    inbox_service = consumer["flow"].FlowCommandInboxService
    original_claim = inbox_service.claim_command

    async def _claim(cls: Any, *args: Any, **kwargs: Any) -> Any:
        result = await original_claim(*args, **kwargs)
        claim_results.append(bool(result.claimed))
        return result

    inbox_service.claim_command = classmethod(_claim)

    publish_service = consumer["publish"].FlowEventPublishService
    original_publish = publish_service.publish_event

    async def _publish(cls: Any, database_arg: Any, publisher: Any, *, queue_name: str, event: dict[str, Any]) -> Any:
        class _Proxy:
            async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
                outbox = await database_arg[publish_service.COLLECTION].find_one({"_id": payload["event_id"]})
                queue_log.append(
                    {
                        "event_id": payload.get("event_id"),
                        "event_type": payload.get("event_type"),
                        "outbox_found": outbox is not None,
                        "outbox_status": None if outbox is None else outbox.get("status"),
                        "payload": payload,
                        "queue_name": queue_name,
                    }
                )
                await publisher.publish(queue_name=queue_name, payload=payload)

        return await original_publish(database_arg, _Proxy(), queue_name=queue_name, event=event)

    publish_service.publish_event = classmethod(_publish)

    connections = FakeConnections(database, redis_client)

    @asynccontextmanager
    async def _lifespan(app: Any) -> Any:
        app.state.connections = connections
        yield

    app = create_app()
    app.router.lifespan_context = _lifespan
    app.state.connections = connections
    client = TestClient(app)
    results: list[dict[str, Any]] = []
    owner = "user_canvas_owner"
    owner_headers = _auth(owner)
    owner_token = owner_headers["Authorization"].removeprefix("Bearer ")
    command_id = "wf_accept_canvas_light"
    ctx: dict[str, Any] = {}

    def login_gate() -> str:
        frontend = ROOT / "novelcomic-frontend"
        canvas = _read(frontend / "src/routes/canvas.$flowId.tsx")
        protected = _read(frontend / "src/routes/-components.tsx")
        require_auth = _read(frontend / "src/features/auth/components/RequireAuth.tsx")
        router = _read(frontend / "src/routes/router.tsx")
        _require("path: '/canvas/$flowId'" in canvas, "画布路由不是 /canvas/$flowId")
        _require("<Protected>" in canvas, "/canvas/{flowId} 没有包在 Protected 里")
        _require("canvasRoute" in router, "路由树没有挂上 canvasRoute")
        _require("RequireAuth" in protected and "function Protected" in protected, "Protected 没有转到 RequireAuth")
        _require("useAuthModalStore" in require_auth and "open()" in require_auth, "未登录时没有打开登录弹窗")
        _require("if (!isLoaded || isSignedIn) return" in require_auth, "登录门闩条件变了")
        vitest = frontend / "node_modules/.bin/vitest"
        _require(vitest.exists(), "前端 vitest 不存在，没法实际渲染登录门闩")
        completed = subprocess.run(
            [
                str(vitest),
                "run",
                "src/test/RequireAuth.test.tsx",
                "src/test/canvas-route-shell.test.tsx",
            ],
            check=False,
            cwd=frontend,
            capture_output=True,
            text=True,
            timeout=180,
        )
        _require(
            completed.returncode == 0,
            "未登录渲染没有打开登录流程:\n"
            + "\n".join((completed.stdout + completed.stderr).strip().splitlines()[-30:]),
        )
        return "未登录渲染为空并打开登录弹窗，/canvas/$flowId 走 Protected"

    def owner_sees_graph() -> str:
        _require(
            not any("/api/v2/flow/project" in item for item in WHITE_LIST),
            "项目读取被放进了认证白名单",
        )
        saved = client.post(
            "/api/v2/flow/project",
            headers=owner_headers,
            json={"project_name": "亮灯验收", "nodes": NODES, "edges": EDGES},
        )
        _require(saved.status_code == 201, saved.text)
        ctx["flow_id"] = saved.json()["data"]["flow_id"]
        anonymous = client.get(f"/api/v2/flow/project/{ctx['flow_id']}")
        _require(anonymous.status_code == 401, f"未登录读项目不是 401: {anonymous.status_code} {anonymous.text}")
        _require(anonymous.json()["code"] == 1002, anonymous.text)
        stranger = client.get(f"/api/v2/flow/project/{ctx['flow_id']}", headers=_auth("user_other"))
        _require(stranger.status_code == 404, f"别人的项目不该读到: {stranger.status_code} {stranger.text}")
        owned = client.get(f"/api/v2/flow/project/{ctx['flow_id']}", headers=owner_headers)
        _require(owned.status_code == 200, owned.text)
        project = owned.json()["data"]
        _require([node["id"] for node in project["nodes"]] == [PROMPT_ID, MODEL_ID], project["nodes"])
        _require([edge["id"] for edge in project["edges"]] == ["edge-prompt-draw"], project["edges"])
        _require(client.app.state.connections is connections, "请求没有走验收里的连接，中间件链路被换掉了")
        return f"flow_id={ctx['flow_id']} nodes={[PROMPT_ID, MODEL_ID]}"

    def first_run() -> str:
        response = client.post(
            "/api/v2/flow/runs",
            headers=owner_headers,
            json=_run_body(client, owner_headers, command_id, ctx["flow_id"]),
        )
        _require(response.status_code == 202, f"第一次 Run 不是 202: {response.status_code} {response.text}")
        data = response.json()["data"]
        _require(data.get("flow_task_id") and data.get("flow_run_id"), data)
        _require(data.get("idempotent_replay") is False, data)
        ctx["flow_task_id"] = data["flow_task_id"]
        ctx["flow_run_id"] = data["flow_run_id"]
        ctx["create_body"] = _run_body(client, owner_headers, command_id, ctx["flow_id"])
        return f"flow_task_id={data['flow_task_id']} flow_run_id={data['flow_run_id']} status={data.get('status')}"

    def idempotent_replay() -> str:
        response = client.post("/api/v2/flow/runs", headers=owner_headers, json=ctx["create_body"])
        _require(response.status_code == 202, response.text)
        data = response.json()["data"]
        _require(data.get("idempotent_replay") is True, data)
        _require(data.get("flow_task_id") == ctx["flow_task_id"], data)
        _require(data.get("flow_run_id") == ctx["flow_run_id"], data)
        _require(len(database["flow_task"].docs) == 1, "同一个命令插入了第二次 run")
        return "idempotent_replay=true"

    def command_conflict() -> str:
        changed = copy.deepcopy(ctx["create_body"])
        changed["flow_task"]["nodes"][0]["data"]["text"] = "换成另一段提示词"
        response = client.post("/api/v2/flow/runs", headers=owner_headers, json=changed)
        _require(response.status_code == 409, f"改 payload 复用 command id 不是 409: {response.status_code} {response.text}")
        _require(len(database["flow_task"].docs) == 1, "冲突请求仍然插入了新 run")
        return response.json()["msg"]

    def stream_and_inbox() -> str:
        _require(PublisherFlowTask.run_flow.queue_name == "run_flow", "发布队列不是 run_flow")
        _require(PublisherFlowTask.run_flow.broker_kind == "REDIS_STREAM", "run_flow 不是 Redis Stream")
        decoder = consumer["flow"].decode_stream_payload
        payloads = [item for item in _stream_payloads(redis_client, decoder) if item.get("command_id") == command_id]
        _require(len(payloads) == 1, f"run_flow 里这个命令不是 1 条: {len(payloads)}")
        payload = payloads[0]
        _require(int(payload.get("protocol_version") or 0) == 2, payload)
        _require(payload.get("reply_queue") == V2_REPLY_QUEUE_NAME, payload.get("reply_queue"))
        class _ReplyPublisher:
            async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
                del queue_name, payload

        worker = consumer["flow"].FlowStreamWorker(
            database=database,
            redis_client=redis_client,
            publisher=_ReplyPublisher(),
            consumer_name="accept-consumer",
        )
        first = _consume_once(worker, redis_client)
        _require(first == 1, f"第一次消费条数不是 1: {first}")
        inbox = asyncio.run(database["flow_command_inbox"].find_one({"_id": command_id}))
        _require(inbox is not None and inbox.get("status") == "completed", f"inbox 没有完成: {inbox}")
        _require(claim_results == [True], f"第一次认领结果不对: {claim_results}")
        entries = asyncio.run(redis_client.xrange("run_flow"))
        original_fields = next(fields for _message_id, fields in entries if fields.get("command_id") == command_id)
        asyncio.run(redis_client.xadd("run_flow", dict(original_fields)))
        second = _consume_once(worker, redis_client)
        _require(second == 1, f"重复投递没有进入 Consumer: {second}")
        _require(claim_results == [True, False], f"inbox 认领次数不对: {claim_results}")
        inbox_after = asyncio.run(database["flow_command_inbox"].find_one({"_id": command_id}))
        _require(len(database["flow_command_inbox"].docs) == 1, "同一个 command_id 写成了多条 inbox")
        _require(int(inbox_after.get("attempts") or 0) == 1, f"重复投递把 attempts 增加了: {inbox_after}")
        runs = [
            document
            for document in database["flow_run_states"].docs
            if document.get("run_id") == ctx["flow_run_id"]
        ]
        _require(len(runs) == 1, f"重复投递初始化了多次 run: {len(runs)}")
        return f"claim={claim_results} inbox={inbox_after.get('status')} attempts={inbox_after.get('attempts')}"

    def model_task_only() -> str:
        posted = [path for method, path in ai_paths if method == "POST"]
        _require(posted == ["/v1/tasks"], f"AI 请求不是只有一次 /v1/tasks: {ai_paths}")
        tasks = database["ai_tasks"].docs
        invocations = database["model_invocations"].docs
        _require(len(tasks) == 1, f"AI task 条数不是 1: {tasks}")
        _require(tasks[0].get("node_id") == MODEL_ID, tasks[0])
        _require(tasks[0].get("ai_task_id"), tasks[0])
        _require(len(invocations) == 1, f"Consumer 没有记下 AI task: {invocations}")
        _require(invocations[0].get("ai_task_id") == tasks[0]["ai_task_id"], invocations[0])
        _require(invocations[0].get("node_id") == MODEL_ID, invocations[0])
        node_states = {
            document.get("node_id"): document.get("status")
            for document in database["flow_node_states"].docs
            if document.get("run_id") == ctx["flow_run_id"]
        }
        _require(node_states.get(PROMPT_ID) == "success", f"普通节点状态不对: {node_states}")
        _require(PROMPT_ID not in {document.get("node_id") for document in tasks}, "普通节点进入了 /v1/tasks")
        return f"ai_task_id={tasks[0]['ai_task_id']} nodes={node_states}"

    def outbox_then_queue() -> str:
        event_types = [item["event_type"] for item in queue_log]
        _require("start_flow" in event_types, f"outbox 发布链里没有 start_flow: {event_types or 'publish_event 没被调用'}")
        _require("node_status" in event_types, f"outbox 发布链里没有 node_status: {event_types}")
        _require(
            all(item["queue_name"] == V2_REPLY_QUEUE_NAME for item in queue_log),
            queue_log,
        )
        _require(all(item["outbox_found"] for item in queue_log), f"消息进队列时 outbox 里还没有记录: {queue_log}")
        published = [
            document
            for document in database["flow_event_outbox"].docs
            if (document.get("event") or {}).get("event_type") in {"start_flow", "node_status"}
        ]
        _require(published, "flow_event_outbox 没有 start_flow / node_status")
        _require(all(document.get("status") == "sent" for document in published), published)
        sample = queue_log[0]["payload"]
        before = len(database["flow_event_outbox"].docs)
        before_queue = len(queue_log)

        async def _retry() -> None:
            class _Quiet:
                async def publish(self, *, queue_name: str, payload: dict[str, Any]) -> None:
                    del queue_name, payload
                    raise AssertionError("同一个 event_id 重试又发了一次")

            await publish_service.publish_event(
                database,
                _Quiet(),
                queue_name=V2_REPLY_QUEUE_NAME,
                event=sample,
            )

        asyncio.run(_retry())
        _require(len(database["flow_event_outbox"].docs) == before, "同一个 event_id 插入了第二条 outbox")
        _require(len(queue_log) == before_queue, "同一个 event_id 重试又进入了 reply queue")
        ctx["reply_events"] = [item["payload"] for item in queue_log]
        return f"events={event_types}"

    def ack_after_append() -> str:
        events = ctx.get("reply_events") or []
        _require(events, "没有从 outbox 进入 v2 reply queue 的消息，不能证明 ACK 顺序")
        order: list[str] = []
        cursors: list[str] = []
        original_append = WorkflowEventStore.append_event

        async def _append(*args: Any, **kwargs: Any) -> dict[str, Any]:
            try:
                stored = await original_append(*args, **kwargs)
            except Exception:
                order.append("append_fail")
                raise
            order.append("append_ok")
            cursors.append(str(stored["cursor"]))
            return stored

        async def _append_method(cls: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
            del cls
            return await _append(*args, **kwargs)

        WorkflowEventStore.append_event = classmethod(_append_method)  # type: ignore[method-assign]
        try:
            delivered: list[RecordingMessage] = []
            for event in events:
                message = RecordingMessage(
                    json.dumps(event, ensure_ascii=False, default=str).encode(),
                    order,
                )
                asyncio.run(workflow_v2_mq_callback(message, database=database, redis_client=redis_client))
                delivered.append(message)
            _require(all(message.actions == ["ack"] for message in delivered), [message.actions for message in delivered])
            body = json.dumps(events[0], ensure_ascii=False, default=str).encode()
            replayed = RecordingMessage(body, order)
            asyncio.run(workflow_v2_mq_callback(replayed, database=database, redis_client=redis_client))
            _require(replayed.actions == ["ack"], replayed.actions)
            _require(cursors[0] == cursors[len(events)], f"重复 event_id 没有返回原 cursor: {cursors}")
            failed = copy.deepcopy(events[0])
            failed["event_id"] = f"{failed.get('event_id')}-redis-down"
            redis_client.eval_error = RuntimeError("redis append failed")
            broken = RecordingMessage(json.dumps(failed, ensure_ascii=False, default=str).encode(), order)
            asyncio.run(workflow_v2_mq_callback(broken, database=database, redis_client=redis_client))
            _require(broken.actions == ["nack:True"], f"Redis 失败时的 MQ 动作不对: {broken.actions}")
            _assert_ack_order(order)
        finally:
            WorkflowEventStore.append_event = original_append  # type: ignore[method-assign]
        ctx["event_cursor"] = cursors[0]
        return f"order={order} cursor={cursors[0]}"

    def websocket_handshake() -> str:
        denied = _websocket_frames(
            client,
            ctx["flow_task_id"],
            owner_token,
            first_frame={"event_type": "attach_flow", "protocol_version": 2},
        )
        _require(denied and denied[0].get("event_type") == "error", f"没先 auth 也被接受了: {denied}")
        frames = _websocket_frames(client, ctx["flow_task_id"], owner_token)
        ctx["frames"] = frames
        event_types = [frame.get("event_type") for frame in frames]
        _require(event_types[:3] == ["authenticated", "replay", "resume_ready"], event_types)
        return f"frames={event_types}"

    def nodes_light_up() -> str:
        history = _reduce_canvas(_logical_events(ctx.get("frames") or []))
        ctx["history"] = history
        prompt = history[PROMPT_ID]
        model = history[MODEL_ID]
        _require("running" in prompt and "success" in prompt, f"普通节点没有跑完: {prompt}")
        _require(prompt.index("running") < prompt.index("success"), f"普通节点亮灯顺序不对: {prompt}")
        _require("running" in model, f"模型节点没有变成 running: {model}")
        _require("success" not in model, f"模型节点在 AI 回调前就变成了 success: {model}")
        return str(history)

    def refresh_replays_cursor() -> str:
        active = client.get(
            "/api/v2/flow/runs",
            headers=owner_headers,
            params={"flow_id": ctx["flow_id"], "status": "active"},
        )
        _require(active.status_code == 200, active.text)
        active_ids = [item.get("flow_task_id") for item in active.json()["data"]]
        _require(ctx["flow_task_id"] in active_ids, f"刷新后 active run 里没有这次执行: {active.json()['data']}")
        events = [
            event
            for event in _logical_events(ctx.get("frames") or [])
            if event.get("cursor") and event.get("event_id")
        ]
        _require(len(events) >= 2, f"事件不足两条，没法按 cursor 补齐: {events}")
        frames = _websocket_frames(client, ctx["flow_task_id"], owner_token, cursor=str(events[0]["cursor"]))
        replay = next((frame for frame in frames if frame.get("event_type") == "replay"), None)
        _require(replay is not None, frames)
        replay_ids = [event.get("event_id") for event in replay.get("events") or []]
        _require(events[0]["event_id"] not in replay_ids, f"cursor 之前的事件又推了一遍: {replay_ids}")
        _require(events[1]["event_id"] in replay_ids, f"cursor 之后的事件没有补齐: {replay_ids}")
        _require(any(frame.get("event_type") == "resume_ready" for frame in frames), frames)
        return f"active={active_ids} replay={replay_ids}"

    def cancel_versus_close() -> str:
        closed = client.get(f"/api/v2/flow/runs/{ctx['flow_task_id']}", headers=owner_headers)
        _require(closed.status_code == 200, closed.text)
        closed_status = closed.json()["data"]["status"]
        _require(closed_status not in {"cancelled", "canceled"}, f"只关页面就把 run 取消了: {closed_status}")
        resumed = _websocket_frames(client, ctx["flow_task_id"], owner_token, cursor=ctx.get("event_cursor"))
        _require(any(frame.get("event_type") == "resume_ready" for frame in resumed), resumed)
        still = client.get(f"/api/v2/flow/runs/{ctx['flow_task_id']}", headers=owner_headers)
        _require(still.json()["data"]["status"] == closed_status, "重连之后 run 状态变了")
        cancelled = client.post(
            f"/api/v2/flow/runs/{ctx['flow_task_id']}/cancel",
            headers=owner_headers,
            json={"command_id": "cancel_accept_canvas_light"},
        )
        _require(cancelled.status_code == 202, cancelled.text)
        _require(cancelled.json()["data"]["status"] == "cancelled", cancelled.text)
        after = client.get(
            "/api/v2/flow/runs",
            headers=owner_headers,
            params={"flow_id": ctx["flow_id"], "status": "active"},
        )
        after_ids = [item.get("flow_task_id") for item in after.json()["data"]]
        _require(ctx["flow_task_id"] not in after_ids, f"cancel 之后还在 active 里: {after.json()['data']}")
        consumer_run = asyncio.run(database["flow_run_states"].find_one({"run_id": ctx["flow_run_id"]}))
        _require(consumer_run is not None, "Consumer 没有这次 run")
        _require(consumer_run.get("status") != "running", f"cancel 之后 Consumer run 仍在跑: {consumer_run.get('status')}")
        return f"after_close={closed_status} after_cancel=cancelled consumer={consumer_run.get('status')}"

    try:
        _check(results, 1, "未登录访问 /canvas/{flowId} 会进入登录流程", login_gate)
        _check(results, 2, "登录后能看见自己的 nodes / edges", owner_sees_graph)
        _check(results, 3, "第一次 Run 返回 202、flow_task_id、flow_run_id", first_run)
        _check(results, 4, "同一个 client_request_id 返回原 run，idempotent_replay=true", idempotent_replay)
        _check(results, 5, "改 payload 但复用同一 command id，返回冲突", command_conflict)
        _check(results, 6, "Redis Stream run_flow 有这条命令，Consumer inbox 只认领一次", stream_and_inbox)
        _check(results, 7, "模型节点能创建 AI task；普通节点不进入 /v1/tasks", model_task_only)
        _check(results, 8, "start_flow 和 node_status 先在 outbox，再进入 v2 reply queue", outbox_then_queue)
        _check(results, 9, "Publisher 在 append_event() 成功之后才 ACK RabbitMQ", ack_after_append)
        _check(results, 10, "WebSocket 先 auth，再 attach_flow，最后收到 resume_ready", websocket_handshake)
        _check(results, 11, "对应节点先变成 running，完成后变成 success", nodes_light_up)
        _check(results, 12, "运行中刷新能查到 active run，并按 cursor 补齐错过事件", refresh_replays_cursor)
        _check(results, 13, "cancel 后 run 停止；只关闭页面时 run 继续并可再接上", cancel_versus_close)
    finally:
        ai_server.should_exit = True
        ai_thread.join(2)
    return results


def main() -> int:
    logging.disable(logging.CRITICAL)
    report_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    results = _run(FakeDatabase(), MemoryRedis())
    passed = sum(1 for item in results if item["ok"])
    for item in results:
        mark = "通过" if item["ok"] else "失败"
        detail = item["detail"].replace("\n", " ")
        print(f"{mark} {item['step']:02d} {item['name']} — {detail}")
    print(
        f"闭环 {passed}/{len(results)}。"
        "命令、Stream、Consumer、AI、outbox、Event Store、WebSocket、节点状态需要全部通过。"
    )
    payload = json.dumps(results, ensure_ascii=False)
    if report_path is not None:
        report_path.write_text(payload, encoding="utf-8")
    print(f"ACCEPT_JSON {payload}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
