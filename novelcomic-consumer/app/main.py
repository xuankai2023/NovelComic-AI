import asyncio
import hashlib
import hmac
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import get_settings
from app.controller.health import router as health_router
from app.controller.internal import register_internal_api
from app.core.sentry import init_sentry
from app.database.connections import Connections
from app.database.mongo import test_mongo
from app.database.mq import ConnectionReplyPublisher
from app.services.callback.callback_parser import (
    AiTaskCallbackError,
    AiTaskPublicCallbackPayload,
    CallbackParser,
)
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.tasks.flow import FlowStreamWorker
from app.tasks.setup import register_maintenance_tasks
from app.utils.trace_context import set_trace_id


def _verify_callback_timestamp(timestamp: str, *, now: datetime | None = None) -> bool:
    settings = get_settings()
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    current = now or datetime.now(UTC)
    age = abs((current - parsed.astimezone(UTC)).total_seconds())
    return age <= settings.consumer_webhook_timestamp_tolerance_seconds


def _verify_callback_signature(headers: object, raw_body: bytes) -> bool:
    """密钥为空则跳过验签；配了密钥才核对 x-oc-timestamp 和 x-oc-signature。"""

    settings = get_settings()
    if not settings.consumer_webhook_secret:
        return True
    timestamp = headers.get("x-oc-timestamp")
    signature = headers.get("x-oc-signature")
    if not timestamp or not signature or not _verify_callback_timestamp(timestamp):
        return False
    expected = hmac.new(
        settings.consumer_webhook_secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(str(signature), expected)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.connections = await Connections.connect(settings)
    database = app.state.connections.mongo[settings.mongo_database]
    try:
        await test_mongo()
    except BaseException:
        await app.state.connections.close()
        raise
    publisher = ConnectionReplyPublisher(app.state.connections)
    worker = FlowStreamWorker(
        database=database,
        redis_client=app.state.connections.redis,
        publisher=publisher,
        consumer_name=settings.app_name,
    )
    worker_task = asyncio.create_task(worker.run(), name="flow-stream-worker")
    maintenance = None
    try:
        maintenance = register_maintenance_tasks(
            database,
            app.state.connections.redis,
            publisher,
        )
        yield
    finally:
        worker.stop()
        if maintenance is not None:
            maintenance.stop()
        await worker_task
        if maintenance is not None:
            await maintenance.wait_stopped()
        await app.state.connections.close()


def create_app() -> FastAPI:
    settings = get_settings()
    init_sentry(settings.sentry_dsn, settings.sentry_environment)
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    register_internal_api(app)

    @app.post("/callbacks/models/{vendor}")
    async def model_callback(vendor: str, request: Request):
        set_trace_id(None)
        raw_body = await request.body()
        if not _verify_callback_signature(request.headers, raw_body):
            return JSONResponse(status_code=401, content={"status": "invalid_signature"})

        idempotency_key = request.headers.get("x-oc-idempotency-key")
        if not idempotency_key:
            return JSONResponse(status_code=400, content={"status": "missing_idempotency_key"})

        try:
            raw_payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
            parsed = CallbackParser.parse(vendor, raw_payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return JSONResponse(status_code=400, content={"status": "invalid_json"})
        except ValidationError as exc:
            return JSONResponse(
                status_code=400,
                content={"status": "invalid_payload", "errors": exc.errors()},
            )

        settings = get_settings()
        connections = request.app.state.connections
        database = connections.mongo[settings.mongo_database]
        publisher = getattr(
            request.app.state,
            "callback_publisher",
            ConnectionReplyPublisher(connections),
        )
        body = parsed.raw_payload
        invocation = await ModelInvocationService.handle_callback_fast(
            database,
            vendor=vendor,
            payload=body,
            idempotency_key=idempotency_key,
        )
        finalize_scheduled = False
        if invocation is not None and invocation.get("_schedule_finalize"):
            from app.services.invocation.invocation_finalizer import InvocationFinalizer

            finalize_scheduled = await InvocationFinalizer.schedule_finalize(
                database,
                redis_client=getattr(connections, "redis", None),
                publisher=publisher,
                invocation_id=str(invocation["invocation_id"]),
            )
        return {
            "status": "accepted",
            "ai_task_id": parsed.external_task_id,
            "finalize_scheduled": finalize_scheduled,
            "matched": invocation is not None,
            "vendor": vendor,
        }

    return app


app = create_app()
