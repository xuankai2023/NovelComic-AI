from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import release_smoke

WORKFLOW = ROOT / ".github" / "workflows" / "release-smoke.yml"
ADR = ROOT / "docs" / "adr" / "ADR-0001.md"


class Scripted:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def exchange(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        return self.handler(method, url, headers, body)


def _config(**overrides: str) -> release_smoke.SmokeConfig:
    values = {
        "slot_url": "http://127.0.0.1:8002",
        "publisher_url": "http://127.0.0.1:8002",
        "consumer_url": "http://127.0.0.1:9001",
        "flow_id": "flow-1",
        "email": "smoke@example.com",
        "password": "secret-pass",
        "external_url": "",
        "notify_webhook": "",
        "webhook_secret": "",
        "events_url": "",
    }
    values.update(overrides)
    return release_smoke.SmokeConfig(**values)


def _ok(body: dict[str, object], status: int = 200) -> release_smoke.HttpResponse:
    return release_smoke.HttpResponse(status, json.dumps(body).encode("utf-8"))


def _happy(method: str, url: str, headers, body) -> release_smoke.HttpResponse:
    del method, headers, body
    if url.endswith("/health"):
        return _ok({"status": "ok"})
    if url.endswith("/readyz"):
        return _ok({"status": "ok", "active_ws": 0})
    if url.endswith("/login-with-password"):
        return _ok({"code": 200, "data": {"ticket": "jwt-1", "user_id": "user-1"}})
    if url.endswith("/project/flow-1"):
        return _ok({"code": 200, "data": {"flow_id": "flow-1", "nodes": [], "edges": []}})
    if url.endswith("/flow/runs"):
        return _ok({"code": 200, "data": {"flow_task_id": "task-1", "status": "queued"}}, 202)
    if url.endswith("/callbacks/models/opencreator_ai"):
        return _ok({"status": "accepted", "matched": True})
    if url.endswith("/flow/runs/task-1"):
        return _ok({"code": 200, "data": {"flow_task_id": "task-1", "status": "completed"}})
    if url.endswith("/events/release-smoke"):
        return release_smoke.HttpResponse(
            200,
            b"event: run.completed\ndata: {}\n\n",
            {"content-type": "text/event-stream"},
        )
    raise AssertionError(url)


def test_closed_slot_port_exits_nonzero_before_login() -> None:
    def handler(method, url, headers, body):
        del method, headers, body
        raise ConnectionError("connection refused")

    transport = Scripted(handler)
    result = release_smoke.execute_smoke(_config(), transport)

    assert result.code == 1
    assert len(transport.calls) == 1
    assert transport.calls[0][1].endswith("/health")
    assert "目标端口不通" in "\n".join(result.lines)
    assert "发布前冒烟通过" not in "\n".join(result.lines)


def test_health_ok_but_callback_rejected_fails_the_job() -> None:
    def handler(method, url, headers, body):
        if url.endswith("/callbacks/models/opencreator_ai"):
            return _ok({"status": "invalid_signature"}, 401)
        return _happy(method, url, headers, body)

    transport = Scripted(handler)
    result = release_smoke.execute_smoke(_config(), transport)
    text = "\n".join(result.lines)

    assert result.code == 1
    assert "目标 slot /health 200" in text
    assert "callback 进入 Consumer 状态码 401" in text
    assert "发布前冒烟通过" not in text
    assert not any(url.endswith("/flow/runs/task-1") for _method, url, _headers, _body in transport.calls)


def test_full_chain_reaches_terminal_event() -> None:
    transport = Scripted(_happy)
    result = release_smoke.execute_smoke(_config(webhook_secret="top-secret"), transport)
    text = "\n".join(result.lines)
    callback = next(call for call in transport.calls if call[1].endswith("/callbacks/models/opencreator_ai"))
    raw = callback[3] or b""
    timestamp = callback[2]["x-oc-timestamp"]
    expected = hmac.new(b"top-secret", timestamp.encode("utf-8") + b"." + raw, hashlib.sha256).hexdigest()

    assert result.code == 0
    assert callback[2]["x-oc-signature"] == expected
    assert "Authorization" not in callback[2]
    login = next(call for call in transport.calls if call[1].endswith("/login-with-password"))
    project = next(call for call in transport.calls if "/project/flow-1" in call[1])
    assert project[2]["Authorization"] == "Bearer jwt-1"
    assert b"secret-pass" in (login[3] or b"")
    assert "secret-pass" not in text
    assert "RabbitMQ 把结果交回 Publisher 200" in text
    assert "run.completed" in text
    assert text.index("目标 slot /health") < text.index("登录并取得 JWT")
    assert text.index("callback 进入 Consumer") < text.index("RabbitMQ 把结果交回 Publisher")
    assert text.index("RabbitMQ 把结果交回 Publisher") < text.index("WS 或 SSE 收到终态")


def test_external_dns_and_webhook_failures_are_warnings() -> None:
    def handler(method, url, headers, body):
        if url == "https://public.example":
            raise ConnectionError("dns")
        if url == "https://hooks.example/notify":
            return release_smoke.HttpResponse(500, b"no")
        return _happy(method, url, headers, body)

    result = release_smoke.execute_smoke(
        _config(
            external_url="https://public.example",
            notify_webhook="https://hooks.example/notify",
        ),
        Scripted(handler),
    )
    text = "\n".join(result.lines)

    assert result.code == 0
    assert "::warning::外部 DNS 还没切完，不证明 run 和 callback" in text
    assert "::warning::通知 webhook 失败，不证明 run 和 callback" in text
    assert "发布前冒烟通过" in text


def test_readyz_failure_does_not_create_a_run() -> None:
    def handler(method, url, headers, body):
        if url.endswith("/readyz"):
            return release_smoke.HttpResponse(503, b'{"status":"draining"}')
        return _happy(method, url, headers, body)

    transport = Scripted(handler)
    result = release_smoke.execute_smoke(_config(), transport)

    assert result.code == 1
    assert "readyz 状态码 503" in "\n".join(result.lines)
    assert not any(url.endswith("/flow/runs") for _method, url, _headers, _body in transport.calls)


def test_cli_closed_port_writes_a_failing_log(tmp_path: Path) -> None:
    log_path = tmp_path / "release-smoke.log"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "release_smoke.py"),
            "--slot-url",
            "http://127.0.0.1:9",
            "--publisher-url",
            "http://127.0.0.1:9",
            "--log",
            str(log_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    text = log_path.read_text(encoding="utf-8")

    assert result.returncode == 1
    assert "目标端口不通" in text
    assert "发布前冒烟通过" not in text


def test_workflow_runs_smoke_before_optional_drain_verify() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert text.index("scripts/release_smoke.py") < text.index("verify_bluegreen_drain.py")
    assert "if: ${{ inputs.verify_consumer_drain }}" in text
    assert "continue-on-error" not in text
    assert "actions/upload-artifact@v4" in text
    assert "if: always()" in text
    assert "不代替" in text


def test_adr_is_proposed_and_points_at_the_pr_workflows() -> None:
    text = ADR.read_text(encoding="utf-8")
    assert "ADR-0001" in text
    assert "Proposed" in text
    assert "待复审" in text
    assert "novelcomic-platform" in text
    assert "2026-12-31" in text
    assert "Superseded by" in text
    assert "空，直到下一号替换它" in text
    assert "p50" in text and "p95" in text
    assert "Flaky" in text
    assert "PR、夜间、发布前、生产" in text
    assert "MTTR" in text
    for relative in (
        "novelcomic-frontend/.github/workflows/ci.yml",
        "novelcomic-publisher/.github/workflows/ci.yml",
        "novelcomic-consumer/.github/workflows/ci.yml",
        "novelcomic-ai/.github/workflows/ci.yml",
        "novelcomic-agent/.github/workflows/ci.yml",
        ".github/workflows/nightly-matrix.yml",
        ".github/workflows/release-smoke.yml",
    ):
        assert relative in text
        assert (ROOT / relative).is_file()
    publisher = (ROOT / "novelcomic-publisher/deploy/deploy-publisher-bluegreen-prod.sh").read_text(
        encoding="utf-8"
    )
    consumer = (ROOT / "novelcomic-consumer/deploy/deploy-consumer-bluegreen-prod.sh").read_text(
        encoding="utf-8"
    )
    assert publisher.index("if ! run_release_smoke") < publisher.index("蓝绿部署成功")
    assert consumer.index("if ! run_release_smoke") < consumer.index("蓝绿部署成功")
    assert "verify_bluegreen_drain.py" in consumer
    assert "不代替 Publisher 和 Agent" in consumer
