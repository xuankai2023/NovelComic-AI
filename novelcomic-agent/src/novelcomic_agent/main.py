"""FastAPI application entrypoint."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from novelcomic_agent.api.server import create_agent_router, start_agent_slot, stop_agent_slot
from novelcomic_agent.comic.runtime import start_stage_b_process
from novelcomic_agent.config import Settings, get_settings
from novelcomic_agent.dependencies import DependencyManager
from novelcomic_agent.posthog import init_posthog
from novelcomic_agent.sentry import init_sentry


def _all_dependencies_ok(checks: dict[str, dict[str, Any]]) -> bool:
    return all(check["status"] == "ok" for check in checks.values())


class CreateAiTaskRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model_id: str = Field(min_length=1)
    options: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None
    trace_id: str | None = None
    user_id: str | None = None
    flow_task_id: str | None = None
    flow_run_id: str | None = None
    node_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


def create_app(
    settings: Settings | None = None,
    dependency_manager: DependencyManager | None = None,
) -> FastAPI:
    """Create the application, optionally injecting dependencies for tests."""

    resolved_settings = settings or get_settings()
    init_sentry(resolved_settings.sentry_dsn, resolved_settings.sentry_environment)
    init_posthog(
        api_key=resolved_settings.posthog_api_key,
        enabled=resolved_settings.posthog_enabled,
        host=resolved_settings.posthog_host,
    )
    manager = dependency_manager or DependencyManager(resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.dependencies = manager
        app.state.settings = resolved_settings
        await manager.start()
        comic = None
        slot_started = False
        try:
            pool = getattr(manager, "postgres", None)
            if pool is not None:
                comic = await start_stage_b_process(
                    app,
                    settings=resolved_settings,
                    pool=pool,
                    connect_rabbit=manager.rabbitmq_connection,
                )
                app.state.comic = comic
            if getattr(manager, "redis", None) is not None:
                await start_agent_slot(app)
                slot_started = True
            yield
        finally:
            if comic is not None:
                await comic.aclose()
            if slot_started:
                await stop_agent_slot(app)
            await manager.close()

    app = FastAPI(title=resolved_settings.app_name, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip()
            for origin in resolved_settings.cors_origins.split(",")
            if origin.strip()
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/readyz", tags=["system"])
    async def readiness(request: Request) -> JSONResponse:
        checks = await request.app.state.dependencies.check_all()
        ready = _all_dependencies_ok(checks)
        return JSONResponse(
            status_code=200 if ready else 503,
            content={"status": "ready" if ready else "unavailable", "checks": checks},
        )

    @app.get("/v1/events/ping", tags=["events"])
    async def event_ping() -> StreamingResponse:
        async def stream() -> AsyncIterator[str]:
            yield 'event: ping\ndata: {"status":"ok"}\n\n'

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/tasks", tags=["tasks"])
    async def create_ai_task(body: CreateAiTaskRequest, request: Request) -> JSONResponse:
        ai_task_id = uuid4().hex
        now_doc = {
            "ai_task_id": ai_task_id,
            "flow_run_id": body.flow_run_id,
            "flow_task_id": body.flow_task_id,
            "idempotency_key": body.idempotency_key,
            "metadata": body.metadata,
            "model_id": body.model_id,
            "node_id": body.node_id,
            "options": body.options,
            "status": "queued",
            "trace_id": body.trace_id,
            "user_id": body.user_id,
        }
        database = request.app.state.dependencies.mongo[resolved_settings.mongodb_database]
        await database["ai_tasks"].insert_one(dict(now_doc))
        return JSONResponse(
            status_code=202,
            content={
                "code": 200,
                "msg": "queued",
                "data": {"ai_task_id": ai_task_id, "status": "queued"},
            },
        )

    app.include_router(create_agent_router(resolved_settings))
    return app


app = create_app()
