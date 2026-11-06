import asyncio
import os
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])

PUBLISHER_MAINTENANCE_PATH = "/tmp/publisher_maintenance"
CONSUMER_HEALTH_TIMEOUT_SECONDS = 5.0


def _maintenance_file_present() -> bool:
    return os.path.exists(PUBLISHER_MAINTENANCE_PATH)


def _active_websocket_count() -> int:
    from app.controller.v2.flow_runs import _workflow_sockets

    return len(_workflow_sockets)


async def check_consumer_health(base_url: str) -> dict[str, Any]:
    if not base_url:
        return {"status": "unreachable", "error": "missing url"}
    try:
        async with httpx.AsyncClient(timeout=CONSUMER_HEALTH_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{base_url.rstrip('/')}/health")
        if response.status_code == 200:
            payload = response.json()
            if isinstance(payload, dict):
                return {"status": "ok", **payload}
            return {"status": "ok"}
        return {"status": "error", "code": response.status_code}
    except Exception as error:
        return {"status": "unreachable", "error": str(error)}


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health2")
async def health2() -> JSONResponse:
    return JSONResponse(status_code=200, content={"status": "ok", "code": 200})


@router.get("/readyz")
async def readyz() -> JSONResponse:
    active_ws = _active_websocket_count()
    if _maintenance_file_present():
        return JSONResponse(
            status_code=503,
            content={"status": "draining", "active_ws": active_ws},
        )
    return JSONResponse(status_code=200, content={"status": "ok", "active_ws": active_ws})


@router.get("/health/consumer")
async def health_consumer() -> JSONResponse:
    settings = get_settings()
    blue_result, green_result = await asyncio.gather(
        check_consumer_health(settings.consumer_blue_url),
        check_consumer_health(settings.consumer_green_url),
    )
    all_ok = blue_result["status"] == "ok" and green_result["status"] == "ok"
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={
            "status": "ok" if all_ok else "degraded",
            "code": 200 if all_ok else 503,
            "consumers": {"blue": blue_result, "green": green_result},
        },
    )
