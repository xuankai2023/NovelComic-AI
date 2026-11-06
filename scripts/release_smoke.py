#!/usr/bin/env python3
"""发布前冒烟。切流之后、成功通知之前跑。

目标端口不通，或 /health 已通但后面的 run / callback 失败，退出码非零。
外部 DNS 还没切完、通知 webhook 失败只记 warning，日志写明它不证明 run 和 callback。
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

TERMINAL_EVENTS = frozenset(
    {
        "finish_flow",
        "workflow_run.finished",
        "fail_flow",
        "workflow_error",
        "workflow_run.failed",
        "cancel_flow",
        "flow_killed",
        "workflow_run.cancelled",
        "run.completed",
        "run.failed",
        "run.cancelled",
    }
)
TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "killed", "cancelled"})
WARNING_LIMIT = "不证明 run 和 callback"


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


class Transport(Protocol):
    def exchange(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> HttpResponse: ...


@dataclass(frozen=True)
class SmokeConfig:
    slot_url: str
    publisher_url: str
    consumer_url: str
    flow_id: str
    email: str
    password: str
    external_url: str = ""
    notify_webhook: str = ""
    webhook_secret: str = ""
    events_url: str = ""


@dataclass(frozen=True)
class SmokeResult:
    code: int
    lines: tuple[str, ...]


class UrllibTransport:
    def __init__(self, timeout: float = 10) -> None:
        self.timeout = timeout

    def exchange(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> HttpResponse:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw_headers = {key.lower(): value for key, value in response.headers.items()}
                return HttpResponse(response.status, response.read(), raw_headers)
        except urllib.error.HTTPError as exc:
            raw_headers = {key.lower(): value for key, value in (exc.headers or {}).items()}
            return HttpResponse(exc.code, exc.read(), raw_headers)
        except urllib.error.URLError as exc:
            raise ConnectionError(str(exc.reason)) from exc


def execute_smoke(config: SmokeConfig, transport: Transport) -> SmokeResult:
    lines: list[str] = []
    slot = _base(config.slot_url)
    publisher = _base(config.publisher_url)
    consumer = _base(config.consumer_url)

    health = _critical_get(transport, lines, f"{slot}/health", "目标 slot /health")
    if health is None:
        return _finish(1, lines)
    ready = _critical_get(transport, lines, f"{slot}/readyz", "目标 slot /readyz")
    if ready is None:
        return _finish(1, lines)

    if not config.email or not config.password:
        lines.append("::error::缺少登录邮箱或密码")
        return _finish(1, lines)
    if not config.flow_id:
        lines.append("::error::缺少 flow_id")
        return _finish(1, lines)
    if not consumer:
        lines.append("::error::缺少 Consumer 地址")
        return _finish(1, lines)

    login = _post_json(
        transport,
        lines,
        f"{publisher}/api/v2/auth/login-with-password",
        {"email": config.email, "password": config.password},
        {},
        "登录并取得 JWT",
    )
    if login is None:
        return _finish(1, lines)
    ticket = _dig(login, "data", "ticket")
    if not isinstance(ticket, str) or not ticket:
        lines.append("::error::登录响应没有 JWT")
        return _finish(1, lines)
    auth = {"Authorization": f"Bearer {ticket}"}

    project = _get_json(
        transport,
        lines,
        f"{publisher}/api/v2/flow/project/{config.flow_id}",
        auth,
        "读取自己的 flow project",
    )
    if project is None:
        return _finish(1, lines)
    project_id = _dig(project, "data", "flow_id")
    if project_id != config.flow_id:
        lines.append("::error::flow project 不是当前账号的")
        return _finish(1, lines)

    created = _post_json(
        transport,
        lines,
        f"{publisher}/api/v2/flow/runs",
        _shortest_run(config.flow_id),
        auth,
        "创建最短 workflow run",
        ok_status=(200, 202),
    )
    if created is None:
        return _finish(1, lines)
    flow_task_id = _dig(created, "data", "flow_task_id")
    if not isinstance(flow_task_id, str) or not flow_task_id:
        lines.append("::error::创建 run 没有 flow_task_id")
        return _finish(1, lines)

    raw_callback, callback_headers = _callback_request(
        flow_task_id,
        secret=config.webhook_secret,
    )
    callback = _exchange_json(
        transport,
        lines,
        "POST",
        f"{consumer}/callbacks/models/opencreator_ai",
        callback_headers,
        raw_callback,
        "callback 进入 Consumer",
    )
    if callback is None or callback.get("status") != "accepted":
        if callback is not None:
            lines.append("::error::callback 没有被 Consumer 接受")
        return _finish(1, lines)

    run = _get_json(
        transport,
        lines,
        f"{publisher}/api/v2/flow/runs/{flow_task_id}",
        auth,
        "RabbitMQ 把结果交回 Publisher",
    )
    if run is None:
        return _finish(1, lines)
    status = str(_dig(run, "data", "status") or "")
    if status not in TERMINAL_RUN_STATUSES:
        lines.append(f"::error::Publisher 还没有终态结果，status={status or 'missing'}")
        return _finish(1, lines)

    events_url = config.events_url or (
        f"{publisher}/api/v2/flow/runs/{flow_task_id}/events/release-smoke"
    )
    events = _critical_get(transport, lines, events_url, "WS 或 SSE 收到终态")
    if events is None:
        return _finish(1, lines)
    names = _terminal_names(events.body, events.headers.get("content-type", ""))
    if not names & TERMINAL_EVENTS:
        lines.append("::error::WS 或 SSE 没有终态事件")
        return _finish(1, lines)
    lines.append(f"WS 或 SSE 收到终态: {sorted(names & TERMINAL_EVENTS)[0]}")

    _warn_probe(
        transport,
        lines,
        config.external_url,
        "外部 DNS 还没切完",
    )
    _warn_probe(
        transport,
        lines,
        config.notify_webhook,
        "通知 webhook 失败",
        method="POST",
        body=b'{"text":"release-smoke"}',
        headers={"Content-Type": "application/json"},
    )
    lines.append("发布前冒烟通过")
    return _finish(0, lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="发布前冒烟")
    parser.add_argument("--slot-url", required=True)
    parser.add_argument("--publisher-url", required=True)
    parser.add_argument("--consumer-url", default="")
    parser.add_argument("--flow-id", default="")
    parser.add_argument("--email", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--external-url", default="")
    parser.add_argument("--notify-webhook", default="")
    parser.add_argument("--webhook-secret", default="")
    parser.add_argument("--events-url", default="")
    parser.add_argument("--log", default="")
    args = parser.parse_args(argv)
    config = SmokeConfig(
        slot_url=args.slot_url,
        publisher_url=args.publisher_url,
        consumer_url=args.consumer_url or os.environ.get("SMOKE_CONSUMER_URL", ""),
        flow_id=args.flow_id or os.environ.get("SMOKE_FLOW_ID", ""),
        email=args.email or os.environ.get("SMOKE_EMAIL", ""),
        password=args.password or os.environ.get("SMOKE_PASSWORD", ""),
        external_url=args.external_url or os.environ.get("SMOKE_EXTERNAL_URL", ""),
        notify_webhook=args.notify_webhook or os.environ.get("SMOKE_NOTIFY_WEBHOOK", ""),
        webhook_secret=args.webhook_secret or os.environ.get("CONSUMER_WEBHOOK_SECRET", ""),
        events_url=args.events_url or os.environ.get("SMOKE_EVENTS_URL", ""),
    )
    result = execute_smoke(config, UrllibTransport())
    text = "\n".join(result.lines)
    print(text)
    if args.log:
        with open(args.log, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return result.code


def _shortest_run(flow_id: str) -> dict[str, object]:
    return {
        "client_request_id": "release-smoke",
        "flow_id": flow_id,
        "flow_task": {"nodes": [{"id": "smoke", "type": "text"}], "edges": []},
        "start_ids": ["smoke"],
        "run_mode": "single_node",
    }


def _callback_request(flow_task_id: str, *, secret: str) -> tuple[bytes, dict[str, str]]:
    now = datetime.now(UTC).isoformat()
    payload = {
        "ai_task_id": flow_task_id,
        "status": "success",
        "model_id": "release-smoke",
        "result": {"output": "ok"},
        "started_at": now,
        "completed_at": now,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    timestamp = now
    headers = {
        "Content-Type": "application/json",
        "x-oc-timestamp": timestamp,
        "x-oc-idempotency-key": f"release-smoke-{flow_task_id}",
    }
    if secret:
        digest = hmac.new(
            secret.encode("utf-8"),
            timestamp.encode("utf-8") + b"." + raw,
            hashlib.sha256,
        ).hexdigest()
        headers["x-oc-signature"] = digest
    return raw, headers


def _terminal_names(body: bytes, content_type: str) -> set[str]:
    text = body.decode("utf-8", errors="replace")
    names: set[str] = set()
    if "text/event-stream" in content_type or text.startswith("event:") or "\nevent:" in text:
        for line in text.splitlines():
            if line.startswith("event:"):
                names.add(line.split(":", 1)[1].strip())
            if line.startswith("data:"):
                payload = line.split(":", 1)[1].strip()
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                names.update(_names_from_json(parsed))
        return names
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return set()
    return _names_from_json(parsed)


def _names_from_json(value: object) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key in ("event", "event_type", "type"):
            item = value.get(key)
            if isinstance(item, str):
                found.add(item)
        events = value.get("events")
        if isinstance(events, list):
            for event in events:
                found.update(_names_from_json(event))
        data = value.get("data")
        if isinstance(data, dict):
            found.update(_names_from_json(data))
    return found


def _critical_get(
    transport: Transport,
    lines: list[str],
    url: str,
    label: str,
) -> HttpResponse | None:
    try:
        response = transport.exchange("GET", url, {}, None)
    except ConnectionError as exc:
        lines.append(f"::error::{label} 目标端口不通: {exc}")
        return None
    if response.status != 200:
        lines.append(f"::error::{label} 状态码 {response.status}")
        return None
    lines.append(f"{label} 200")
    return response


def _get_json(
    transport: Transport,
    lines: list[str],
    url: str,
    headers: Mapping[str, str],
    label: str,
) -> dict[str, object] | None:
    return _exchange_json(transport, lines, "GET", url, headers, None, label)


def _post_json(
    transport: Transport,
    lines: list[str],
    url: str,
    payload: dict[str, object],
    headers: Mapping[str, str],
    label: str,
    ok_status: tuple[int, ...] = (200,),
) -> dict[str, object] | None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    merged = {"Content-Type": "application/json", **dict(headers)}
    return _exchange_json(transport, lines, "POST", url, merged, raw, label, ok_status=ok_status)


def _exchange_json(
    transport: Transport,
    lines: list[str],
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None,
    label: str,
    ok_status: tuple[int, ...] = (200,),
) -> dict[str, object] | None:
    try:
        response = transport.exchange(method, url, headers, body)
    except ConnectionError as exc:
        lines.append(f"::error::{label} 目标端口不通: {exc}")
        return None
    if response.status not in ok_status:
        lines.append(f"::error::{label} 状态码 {response.status}")
        return None
    try:
        parsed = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        lines.append(f"::error::{label} 不是 JSON")
        return None
    if not isinstance(parsed, dict):
        lines.append(f"::error::{label} 不是对象")
        return None
    lines.append(f"{label} {response.status}")
    return parsed


def _warn_probe(
    transport: Transport,
    lines: list[str],
    url: str,
    label: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> None:
    if not url:
        return
    try:
        response = transport.exchange(method, url, headers or {}, body)
    except ConnectionError:
        lines.append(f"::warning::{label}，{WARNING_LIMIT}")
        return
    if response.status >= 400:
        lines.append(f"::warning::{label}，{WARNING_LIMIT}")
        return
    lines.append(f"{label} 已通")


def _dig(payload: dict[str, object], *keys: str) -> object:
    current: object = payload
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _base(url: str) -> str:
    return url.rstrip("/")


def _finish(code: int, lines: list[str]) -> SmokeResult:
    return SmokeResult(code, tuple(lines))


if __name__ == "__main__":
    sys.exit(main())
