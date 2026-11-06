from fastapi.testclient import TestClient

from app.controller.v2 import flow_runs
from app.main import create_app


class ExplodingConnections:
    async def checks(self) -> dict[str, bool]:
        raise AssertionError("readyz must not ping mongo, redis, or rabbitmq")


def client() -> TestClient:
    app = create_app()
    app.state.connections = ExplodingConnections()
    return TestClient(app)


def test_health_only_reports_process_health() -> None:
    response = client().get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health2_returns_ok_code() -> None:
    response = client().get("/health2")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "code": 200}


def test_readyz_ignores_dependency_checks_and_counts_sockets(monkeypatch) -> None:
    previous = dict(flow_runs._workflow_sockets)
    flow_runs._workflow_sockets.clear()
    flow_runs._workflow_sockets[("flow-1", "socket-1")] = object()
    monkeypatch.setattr("app.controller.health._maintenance_file_present", lambda: False)
    try:
        response = client().get("/readyz")
    finally:
        flow_runs._workflow_sockets.clear()
        flow_runs._workflow_sockets.update(previous)

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "active_ws": 1}


def test_readyz_drains_when_maintenance_file_exists(monkeypatch) -> None:
    monkeypatch.setattr("app.controller.health._maintenance_file_present", lambda: True)
    monkeypatch.setattr("app.controller.health._active_websocket_count", lambda: 2)
    response = client().get("/readyz")
    assert response.status_code == 503
    assert response.json() == {"status": "draining", "active_ws": 2}


def test_consumer_health_degrades_when_blue_fails_without_changing_readyz(monkeypatch) -> None:
    async def fake_check(base_url: str) -> dict[str, object]:
        if base_url.endswith("blue"):
            return {"status": "unreachable", "error": "connection refused"}
        return {"status": "ok", "instance_id": "green-1"}

    monkeypatch.setattr("app.controller.health.check_consumer_health", fake_check)
    monkeypatch.setattr("app.controller.health._maintenance_file_present", lambda: False)
    monkeypatch.setattr("app.controller.health._active_websocket_count", lambda: 0)
    app_client = client()
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "consumer_blue_url", "http://blue")
    monkeypatch.setattr(settings, "consumer_green_url", "http://green")

    consumer = app_client.get("/health/consumer")
    ready = app_client.get("/readyz")

    assert consumer.status_code == 503
    assert consumer.json()["status"] == "degraded"
    assert consumer.json()["consumers"]["blue"]["status"] == "unreachable"
    assert consumer.json()["consumers"]["green"]["status"] == "ok"
    assert ready.status_code == 200
    assert ready.json() == {"status": "ok", "active_ws": 0}


def test_consumer_health_is_ok_when_both_sides_are_ok(monkeypatch) -> None:
    async def fake_check(base_url: str) -> dict[str, object]:
        return {"status": "ok", "instance_id": base_url}

    monkeypatch.setattr("app.controller.health.check_consumer_health", fake_check)
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "consumer_blue_url", "http://blue")
    monkeypatch.setattr(settings, "consumer_green_url", "http://green")

    response = client().get("/health/consumer")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["code"] == 200
    assert body["consumers"]["blue"]["status"] == "ok"
    assert body["consumers"]["green"]["status"] == "ok"


def test_public_probe_paths_do_not_require_authorization() -> None:
    app_client = client()
    assert app_client.get("/health2").status_code == 200
    denied = app_client.get("/health/consumer")
    assert denied.status_code == 503
    assert denied.json()["status"] == "degraded"
