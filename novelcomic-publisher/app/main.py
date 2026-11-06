import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.common.exception.handler import register_exception
from app.config import get_settings
from app.controller.health import router as health_router
from app.core.register import register_init, register_middleware, register_router
from app.core.sentry import init_sentry
from app.database.connections import Connections
from app.database.mq import run_main_result_consumers
from app.services.workflow_runs_v2 import workflow_command_dispatcher_forever


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.connections = await Connections.connect(settings)
    database = app.state.connections.mongo[settings.mongo_database]
    try:
        await register_init(database)
    except Exception:
        await app.state.connections.close()
        raise
    result_consumer_task = asyncio.create_task(
        run_main_result_consumers(
            database=database,
            redis_client=app.state.connections.redis,
            rabbitmq_url=app.state.connections.rabbitmq_url,
            connect_timeout=app.state.connections.timeout,
        ),
        name="main_result_consumer",
    )
    dispatcher_task = asyncio.create_task(
        workflow_command_dispatcher_forever(database, app.state.connections.redis),
        name="workflow_v2_command_dispatcher",
    )
    try:
        yield
    finally:
        result_consumer_task.cancel()
        dispatcher_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await result_consumer_task
        with contextlib.suppress(asyncio.CancelledError):
            await dispatcher_task
        await app.state.connections.close()


def create_app() -> FastAPI:
    settings = get_settings()
    init_sentry(settings.sentry_dsn, settings.sentry_environment)
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    register_middleware(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    register_router(app)
    register_exception(app)
    return app


app = create_app()
