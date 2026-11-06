from typing import Any

from fastapi.testclient import TestClient

from novelcomic_agent.config import Settings
from novelcomic_agent.main import create_app


class FakeDependencyManager:
    def __init__(self, checks: dict[str, dict[str, Any]]) -> None:
        self.checks = checks
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True

    async def check_all(self) -> dict[str, dict[str, Any]]:
        return self.checks


def make_checks(status: str = "ok") -> dict[str, dict[str, Any]]:
    return {
        "mongodb": {"status": status},
        "redis": {"status": status},
        "rabbitmq": {"status": status},
    }


def test_lifespan_and_healthy_probes() -> None:
    manager = FakeDependencyManager(make_checks())
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]

    with TestClient(app) as client:
        assert manager.started is True
        health = client.get("/health")
        cors_health = client.get(
            "/health",
            headers={"Origin": "http://localhost:3000"},
        )
        ready = client.get("/readyz")

    assert manager.closed is True
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert cors_health.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready", "checks": make_checks()}


def test_degraded_health_and_unavailable_readiness() -> None:
    checks = make_checks()
    checks["redis"] = {"status": "error", "detail": "ConnectionError"}
    manager = FakeDependencyManager(checks)
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]

    with TestClient(app) as client:
        health = client.get("/health")
        ready = client.get("/readyz")

    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert ready.status_code == 503
    assert ready.json() == {"status": "unavailable", "checks": checks}


def test_preview_drain_is_local_and_health_stays_ok() -> None:
    from novelcomic_agent.api.server import _running_run_tasks

    manager = FakeDependencyManager(make_checks())
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]
    _running_run_tasks.clear()
    _running_run_tasks["run-1"] = object()  # type: ignore[assignment]
    try:
        with TestClient(app, client=("10.1.2.3", 50000)) as remote:
            denied_drain = remote.post("/preview/drain")
            denied_runs = remote.get("/preview/active_runs")
            remote_health = remote.get("/health")
        with TestClient(app, client=("127.0.0.1", 50000)) as local:
            before = local.get("/preview/active_runs")
            drained = local.post("/preview/drain")
            health = local.get("/health")
            after = local.get("/preview/active_runs")
        with TestClient(app, client=("::1", 50000)) as ipv6:
            ipv6_runs = ipv6.get("/preview/active_runs")
        with TestClient(app, client=("localhost", 50000)) as named:
            named_runs = named.get("/preview/active_runs")
    finally:
        _running_run_tasks.clear()

    assert denied_drain.status_code == 404
    assert denied_runs.status_code == 404
    assert remote_health.status_code == 200
    assert remote_health.json() == {"status": "ok"}
    assert before.json()["count"] == 1
    assert before.json()["run_ids"] == ["run-1"]
    assert before.json()["shutting_down"] is False
    assert drained.status_code == 200
    assert drained.json()["shutting_down"] is True
    assert drained.json()["active_runs"] == 1
    assert health.json() == {"status": "ok"}
    assert "run-1" not in health.text
    assert after.json()["count"] == 1
    assert after.json()["shutting_down"] is True
    assert ipv6_runs.status_code == 200
    assert named_runs.status_code == 200


def test_sse_ping_is_finite() -> None:
    manager = FakeDependencyManager(make_checks())
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]

    with TestClient(app) as client:
        response = client.get("/v1/events/ping")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text == 'event: ping\ndata: {"status":"ok"}\n\n'
