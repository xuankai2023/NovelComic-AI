"""Stage B product routes mounted on the existing FastAPI process."""

from __future__ import annotations

import os
from typing import Any

import asyncpg
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from novelcomic_agent.comic.persistence.migrate import apply_migrations
from novelcomic_agent.comic.persistence.postgres import create_pool
from novelcomic_agent.comic.runtime import start_stage_b_process
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.config import Settings
from novelcomic_agent.dependencies import DependencyManager
from novelcomic_agent.main import create_app
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    production_request,
)

ADMIN_DSN = os.environ.get(
    "COMIC_TEST_ADMIN_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
)
_DATABASE = "novelcomic_process_test"
HOSTS = "cdn.example,objects.novelcomic.local"
_TRUNCATE = """
TRUNCATE TABLE
  alerts,
  object_tombstones,
  deliveries,
  worker_jobs,
  outbox_events,
  output_batch_renders,
  shot_budgets,
  cost_entries,
  asset_artifacts,
  compose_commands,
  draft_revisions,
  drafts,
  idempotency_keys,
  productions
RESTART IDENTITY CASCADE
"""


class MemoryWorkerBroker:
    def __init__(self, *, deliver: bool = True) -> None:
        self.deliver = deliver
        self.published: list[dict[str, Any]] = []
        self._handler = None

    async def publish(self, body: dict[str, Any]) -> None:
        self.published.append(dict(body))
        if self.deliver and self._handler is not None:
            await self._handler(body)

    async def consume(self, handler) -> None:
        self._handler = handler

    async def aclose(self) -> None:
        self._handler = None


def _rsa_pair() -> tuple[bytes, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private, public.decode()


def _bearer(private: bytes, user_id: str) -> dict[str, str]:
    token = jwt.encode({"sub": user_id}, private, algorithm="RS256")
    return {"Authorization": f"Bearer {token}"}


def _dsn(database: str) -> str:
    return ADMIN_DSN.rsplit("/", 1)[0] + "/" + database


async def _postgres_available() -> bool:
    try:
        connection = await asyncpg.connect(ADMIN_DSN, timeout=2)
    except Exception:
        return False
    await connection.close()
    return True


async def _ensure_database(name: str) -> None:
    connection = await asyncpg.connect(ADMIN_DSN, timeout=2)
    try:
        exists = await connection.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name)
        if exists is None:
            await connection.execute(f'CREATE DATABASE "{name}"')
    finally:
        await connection.close()


class _ClockManager:
    def __init__(self, *, postgres: object | None) -> None:
        self.postgres = postgres
        self.redis = None
        self.order: list[str] = []

    async def start(self) -> None:
        self.order.append("manager-start")

    async def close(self) -> None:
        self.order.append("manager-close")

    async def check_all(self) -> dict[str, dict[str, str]]:
        return {
            "mongodb": {"status": "ok"},
            "redis": {"status": "ok"},
            "rabbitmq": {"status": "ok"},
            "postgres": {"status": "ok"},
        }

    async def rabbitmq_connection(self) -> object:
        raise AssertionError("rabbitmq should stay behind the injected broker in this test")


def test_lifespan_starts_comic_after_dependencies_and_stops_it_first(monkeypatch) -> None:
    manager = _ClockManager(postgres="pool")

    class _Handle:
        async def aclose(self) -> None:
            manager.order.append("comic-close")

    async def start(app: FastAPI, **kwargs: object) -> _Handle:
        assert kwargs["pool"] == "pool"
        manager.order.append("comic-start")
        router = APIRouter()

        @router.get("/v1/comic-probe")
        async def probe() -> dict[str, bool]:
            return {"ok": True}

        app.include_router(router)
        return _Handle()

    monkeypatch.setattr("novelcomic_agent.main.start_stage_b_process", start)
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]
    with TestClient(app) as client:
        assert client.get("/v1/comic-probe").json() == {"ok": True}
    assert manager.order == ["manager-start", "comic-start", "comic-close", "manager-close"]


def test_lifespan_skips_comic_when_postgres_is_down(monkeypatch) -> None:
    manager = _ClockManager(postgres=None)

    async def start(app: FastAPI, **kwargs: object) -> None:
        del app, kwargs
        raise AssertionError("comic runtime must wait for postgres")

    monkeypatch.setattr("novelcomic_agent.main.start_stage_b_process", start)
    app = create_app(Settings(), dependency_manager=manager)  # type: ignore[arg-type]
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
    assert manager.order == ["manager-start", "manager-close"]


async def test_readyz_checks_postgres() -> None:
    manager = DependencyManager(Settings())

    async def ok() -> None:
        return None

    async def broken() -> None:
        raise ConnectionError("down")

    manager._check_mongodb = ok  # type: ignore[method-assign]
    manager._check_redis = ok  # type: ignore[method-assign]
    manager._check_rabbitmq = ok  # type: ignore[method-assign]
    manager._check_postgres = ok  # type: ignore[method-assign]
    try:
        ready = await manager.check_all()
        manager._check_postgres = broken  # type: ignore[method-assign]
        degraded = await manager.check_all()
    finally:
        await manager.close()
    assert ready["postgres"] == {"status": "ok"}
    assert set(ready) == {"mongodb", "redis", "rabbitmq", "postgres"}
    assert degraded["postgres"] == {"status": "error", "detail": "ConnectionError"}


async def test_missing_cos_settings_fail_startup(monkeypatch) -> None:
    async def migrations(pool: object) -> list[str]:
        del pool
        return []

    monkeypatch.setattr("novelcomic_agent.comic.runtime.apply_migrations", migrations)
    app = FastAPI()
    with pytest.raises(ValueError, match="COS_SECRET_ID"):
        await start_stage_b_process(
            app,
            settings=Settings(),
            pool=object(),
            broker=MemoryWorkerBroker(),
        )


async def test_process_accepts_a_production_and_keeps_the_analyze_outbox() -> None:
    if not await _postgres_available():
        pytest.skip("PostgreSQL is not available")
    await _ensure_database(_DATABASE)
    pool = await create_pool(_dsn(_DATABASE))
    private, public = _rsa_pair()
    settings = Settings(
        clerk_pem_public_key=public,
        comic_allowed_hosts=HOSTS,
        cos_cdn_domain="objects.novelcomic.local",
    )
    app = FastAPI()
    process = None
    try:
        async with pool.acquire() as connection:
            await apply_migrations(pool)
            await connection.execute(_TRUNCATE)
        broker = MemoryWorkerBroker(deliver=False)
        process = await start_stage_b_process(
            app,
            settings=settings,
            pool=pool,
            objects=MemoryObjectStore(),
            remotion=ScriptedRemotion(),
            detector=ScriptedDetector(),
            speech=ScriptedSpeech(),
            cropper=None,
            fetcher=MemoryFetcher({}),
            broker=broker,
            poll_seconds=30,
        )
        body = production_request().model_dump(mode="json", by_alias=True)
        changed = production_request(pages=[("https://cdn.example/other.png", 1)]).model_dump(
            mode="json", by_alias=True
        )
        tenant_a = _bearer(private, "tenant-a")
        tenant_b = _bearer(private, "tenant-b")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            created = await client.post("/v1/comic-productions", json=body, headers=tenant_a)
            replay = await client.post("/v1/comic-productions", json=body, headers=tenant_a)
            conflict = await client.post("/v1/comic-productions", json=changed, headers=tenant_a)
            hidden = await client.get(
                f"/v1/comic-productions/{created.json()['productionId']}",
                headers=tenant_b,
            )
            rejected = await client.post(
                "/v1/comic-productions",
                json={**body, "tenantId": "tenant-b"},
                headers=tenant_a,
            )
        assert created.status_code == 202
        assert created.json()["state"] == "CREATED"
        assert created.json()["replayed"] is False
        assert replay.status_code == 202
        assert replay.json()["productionId"] == created.json()["productionId"]
        assert replay.json()["replayed"] is True
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"
        assert hidden.status_code == 404
        assert rejected.status_code == 422

        production_id = created.json()["productionId"]
        project_id = created.json()["projectId"]
        await process.publisher.publish_available()
        row = await process.runtime.productions.get_row(production_id)
        revision = await process.runtime.drafts.get_revision(project_id, 0)
        events = await process.runtime.productions.list_outbox(production_id)
        assert row.tenant_id == "tenant-a"
        assert row.state == "CREATED"
        assert revision.revision == 0
        assert any(event.payload.get("worker") == "analyze" for event in events)
        assert any(
            item["eventId"] == events[0].event_id and item["worker"] == "analyze"
            for item in broker.published
        )
    finally:
        if process is not None:
            await process.aclose()
        await pool.close()
