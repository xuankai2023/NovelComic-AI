from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}
        self.sets: dict[str, set[str]] = {}
        self.lengths: dict[str, int] = {}
        self.fail_xlen = False

    async def get(self, key: str) -> object:
        return self.values.get(key)

    async def set(self, key: str, value: object) -> bool:
        self.values[key] = value
        return True

    async def scard(self, key: str) -> int:
        return len(self.sets.get(key, set()))

    async def xlen(self, key: str) -> int:
        if self.fail_xlen:
            raise RuntimeError("xlen failed")
        return self.lengths.get(key, 0)


class FakeCollection:
    def __init__(self, docs: list[dict] | None = None) -> None:
        self.docs = list(docs or [])

    async def count_documents(self, query: dict) -> int:
        return sum(1 for doc in self.docs if _matches(doc, query))


class FakeDatabase:
    def __init__(self) -> None:
        self.collections = {
            "flow_run_state": FakeCollection(),
            "model_invocations": FakeCollection(),
            "pending_model_callback": FakeCollection(),
            "flow_event_outbox": FakeCollection(),
        }

    def __getitem__(self, name: str) -> FakeCollection:
        return self.collections[name]


class FakeConnections:
    def __init__(self, redis: FakeRedis, database: FakeDatabase) -> None:
        self.redis = redis
        self.mongo = {get_settings().mongo_database: database}

    async def checks(self) -> dict[str, bool]:
        raise AssertionError("readyz must not use the combined dependency check")


def _matches(doc: dict, query: dict) -> bool:
    for key, expected in query.items():
        value = doc.get(key)
        if isinstance(expected, dict):
            if "$in" in expected and value not in expected["$in"]:
                return False
            if "$lt" in expected and (value is None or value >= expected["$lt"]):
                return False
            continue
        if value != expected:
            return False
    return True


def client(redis: FakeRedis, database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(redis, database)
    return TestClient(app)


def _configure(monkeypatch, *, backlog_limit: int = 0, stale_limit: int = 0) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "consumer_instance_id", "consumer-a")
    monkeypatch.setattr(settings, "readyz_max_flow_resume_backlog", backlog_limit)
    monkeypatch.setattr(settings, "readyz_max_stale_webhook_invocations", stale_limit)


def test_health_reports_instance_and_ignores_backlog(monkeypatch) -> None:
    _configure(monkeypatch)
    redis = FakeRedis()
    redis.lengths["flow_resume"] = 500
    response = client(redis, FakeDatabase()).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "instance_id": "consumer-a"}


def test_readyz_stays_ok_when_thresholds_are_zero(monkeypatch) -> None:
    _configure(monkeypatch)
    redis = FakeRedis()
    redis.lengths["flow_resume"] = 500
    database = FakeDatabase()
    database["model_invocations"].docs.append(
        {
            "status": "running",
            "execution_mode": "webhook",
            "updated_at": datetime.now(UTC) - timedelta(days=2),
        }
    )
    database["flow_run_state"].docs.append({"status": "running"})
    database["pending_model_callback"].docs.append({"status": "pending"})
    database["flow_event_outbox"].docs.append({"status": "failed"})

    response = client(redis, database).get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["instance_id"] == "consumer-a"
    assert body["flow_engine"]["flow_resume_backlog"] == 500
    assert body["flow_engine"]["stale_webhook_invocation_count"] == 1
    assert body["flow_engine"]["running_flow_count"] == 1
    assert body["flow_engine"]["pending_callback_count"] == 1
    assert body["flow_engine"]["failed_event_outbox_count"] == 1


def test_readyz_is_503_while_draining_or_stopped(monkeypatch) -> None:
    _configure(monkeypatch)
    database = FakeDatabase()
    draining = FakeRedis()
    draining.values["opencreator:consumer:intake:consumer-a"] = b"DRAINING"
    draining.sets["opencreator:consumer:inflight:consumer-a"] = {"job-1"}
    draining.lengths["flow_resume"] = 9
    draining_response = client(draining, database).get("/readyz")
    assert draining_response.status_code == 503
    assert draining_response.json()["status"] == "draining"
    assert draining_response.json()["inflight_count"] == 1
    assert draining_response.json()["flow_engine"]["flow_resume_backlog"] == 9

    stopped = FakeRedis()
    stopped.values["opencreator:consumer:intake:consumer-a"] = "STOPPED"
    stopped_response = client(stopped, database).get("/readyz")
    assert stopped_response.status_code == 503
    assert stopped_response.json()["status"] == "stopped"


def test_readyz_compares_backlog_and_stale_only_when_limits_are_positive(monkeypatch) -> None:
    _configure(monkeypatch, backlog_limit=2, stale_limit=1)
    redis = FakeRedis()
    redis.lengths["flow_resume"] = 3
    database = FakeDatabase()
    old = datetime.now(UTC) - timedelta(days=2)
    fresh = datetime.now(UTC)
    database["model_invocations"].docs.extend(
        [
            {"status": "running", "execution_mode": "webhook", "updated_at": old},
            {"status": "running", "execution_mode": "webhook", "updated_at": old},
            {"status": "running", "execution_mode": "webhook", "updated_at": fresh},
            {"status": "success", "execution_mode": "webhook", "updated_at": old},
        ]
    )
    response = client(redis, database).get("/readyz")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["issues"] == ["flow_resume_backlog", "stale_webhook_invocations"]
    assert body["flow_engine"]["flow_resume_backlog"] == 3
    assert body["flow_engine"]["stale_webhook_invocation_count"] == 2
    assert body["flow_engine"]["webhook_running_invocation_count"] == 3


def test_readyz_skips_backlog_comparison_when_xlen_fails(monkeypatch) -> None:
    _configure(monkeypatch, backlog_limit=1)
    redis = FakeRedis()
    redis.fail_xlen = True
    response = client(redis, FakeDatabase()).get("/readyz")
    assert response.status_code == 200
    assert response.json()["flow_engine"]["flow_resume_backlog"] is None


def test_consumer_status_returns_intake_inflight_heartbeat_and_flow_engine(monkeypatch) -> None:
    _configure(monkeypatch)
    redis = FakeRedis()
    redis.values["opencreator:consumer:intake:consumer-a"] = b"ACTIVE"
    redis.values["opencreator:consumer:heartbeat:consumer-a"] = b"2026-09-30T00:00:00Z"
    redis.sets["opencreator:consumer:inflight:consumer-a"] = {"job-1", "job-2"}
    redis.lengths["flow_resume"] = 4
    response = client(redis, FakeDatabase()).get("/ops/consumer/status")
    assert response.status_code == 200
    body = response.json()
    assert body["instance_id"] == "consumer-a"
    assert body["intake_state"] == "ACTIVE"
    assert body["inflight_count"] == 2
    assert body["last_heartbeat"] == "2026-09-30T00:00:00Z"
    assert body["flow_engine"]["flow_resume_backlog"] == 4
