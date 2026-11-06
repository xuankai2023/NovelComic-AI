from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.database.mongo import FLOW_EVENT_OUTBOX, FLOW_RUN_STATE, PENDING_MODEL_CALLBACK
from app.schemas.health import HealthResponse
from app.services.invocation.model_invocation_service import ModelInvocationService
from app.utils.drainable_consumer import (
    INTAKE_ACTIVE,
    INTAKE_DRAINING,
    heartbeat_key,
    inflight_key,
    intake_key,
)

router = APIRouter(tags=["health"])

_RUNNING_STATUSES = ["submitting", "running"]


def _decode_redis_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


async def _flow_engine_health_metrics(redis_client: Any, database: Any) -> dict[str, Any]:
    settings = get_settings()
    flow_resume_backlog = None
    try:
        flow_resume_backlog = await redis_client.xlen(settings.flow_resume_queue_name)
    except Exception:
        flow_resume_backlog = None

    running_filter = {"status": {"$in": _RUNNING_STATUSES}, "execution_mode": "webhook"}
    invocations = database[ModelInvocationService.COLLECTION]
    webhook_running_invocation_count = await invocations.count_documents(running_filter)
    stale_cutoff = datetime.now(UTC) - timedelta(seconds=settings.webhook_callback_timeout_seconds)
    stale_webhook_invocation_count = await invocations.count_documents(
        {**running_filter, "updated_at": {"$lt": stale_cutoff}}
    )
    running_flow_count = await database[FLOW_RUN_STATE].count_documents({"status": "running"})
    pending_callbacks = database[PENDING_MODEL_CALLBACK]
    pending_callback_count = await pending_callbacks.count_documents({"status": "pending"})
    failed_outbox = database[FLOW_EVENT_OUTBOX]
    failed_event_outbox_count = await failed_outbox.count_documents({"status": "failed"})
    return {
        "flow_resume_backlog": flow_resume_backlog,
        "running_flow_count": running_flow_count,
        "webhook_running_invocation_count": webhook_running_invocation_count,
        "stale_webhook_invocation_count": stale_webhook_invocation_count,
        "pending_callback_count": pending_callback_count,
        "failed_event_outbox_count": failed_event_outbox_count,
    }


async def _submitted_webhook_invocation_count(database: Any, instance_id: str) -> int:
    return await database[ModelInvocationService.COLLECTION].count_documents(
        {
            "submitter_instance_id": instance_id,
            "execution_mode": "webhook",
            "status": {"$in": _RUNNING_STATUSES},
        }
    )


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", instance_id=get_settings().consumer_instance_id)


@router.get("/readyz", response_model=None)
async def readyz(request: Request) -> JSONResponse | dict[str, Any]:
    settings = get_settings()
    instance_id = settings.consumer_instance_id
    redis_client = request.app.state.connections.redis
    database = _database(request)
    state = _decode_redis_value(await redis_client.get(intake_key(instance_id)))
    metrics = await _flow_engine_health_metrics(redis_client, database)

    if state in ("DRAINING", "STOPPED"):
        inflight_count = await redis_client.scard(inflight_key(instance_id))
        submitted_webhook_invocation_count = await _submitted_webhook_invocation_count(
            database, instance_id
        )
        return JSONResponse(
            status_code=503,
            content={
                "status": state.lower(),
                "instance_id": instance_id,
                "inflight_count": inflight_count,
                "submitted_webhook_invocation_count": submitted_webhook_invocation_count,
                "flow_engine": metrics,
            },
        )

    readiness_issues: list[str] = []
    backlog = metrics["flow_resume_backlog"]
    if (
        settings.readyz_max_flow_resume_backlog > 0
        and backlog is not None
        and backlog > settings.readyz_max_flow_resume_backlog
    ):
        readiness_issues.append("flow_resume_backlog")
    stale_count = metrics["stale_webhook_invocation_count"]
    stale_limit = settings.readyz_max_stale_webhook_invocations
    if stale_limit > 0 and stale_count > stale_limit:
        readiness_issues.append("stale_webhook_invocations")
    if readiness_issues:
        return JSONResponse(
            status_code=503,
            content={
                "status": "degraded",
                "instance_id": instance_id,
                "issues": readiness_issues,
                "flow_engine": metrics,
            },
        )

    return {"status": "ok", "instance_id": instance_id, "flow_engine": metrics}


@router.get("/ops/consumer/status")
async def consumer_status(request: Request) -> dict[str, Any]:
    settings = get_settings()
    instance_id = settings.consumer_instance_id
    redis_client = request.app.state.connections.redis
    database = _database(request)
    state_raw = await redis_client.get(intake_key(instance_id))
    inflight_count = await redis_client.scard(inflight_key(instance_id))
    heartbeat_raw = await redis_client.get(heartbeat_key(instance_id))
    submitted_webhook_invocation_count = await _submitted_webhook_invocation_count(
        database,
        instance_id,
    )
    metrics = await _flow_engine_health_metrics(redis_client, database)
    return {
        "instance_id": instance_id,
        "intake_state": _decode_redis_value(state_raw) or "UNKNOWN",
        "inflight_count": inflight_count,
        "submitted_webhook_invocation_count": submitted_webhook_invocation_count,
        "last_heartbeat": _decode_redis_value(heartbeat_raw),
        "flow_engine": metrics,
    }


@router.post("/ops/consumer/drain")
async def consumer_drain(request: Request) -> dict[str, str]:
    settings = get_settings()
    instance_id = settings.consumer_instance_id
    await request.app.state.connections.redis.set(intake_key(instance_id), INTAKE_DRAINING)
    return {"status": "draining", "instance_id": instance_id}


@router.post("/ops/consumer/active")
async def consumer_active(request: Request) -> dict[str, str]:
    settings = get_settings()
    instance_id = settings.consumer_instance_id
    await request.app.state.connections.redis.set(intake_key(instance_id), INTAKE_ACTIVE)
    return {"status": "active", "instance_id": instance_id}
