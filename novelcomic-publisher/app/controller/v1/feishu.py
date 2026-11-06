"""Feishu event subscription callbacks."""

import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.config import get_settings
from app.schemas.feishu import FeishuEventCallback
from app.services.feishu.feishu_decrypt import decrypt_feishu_payload
from app.services.feishu.feishu_event_service import FeishuEventService

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/event", summary="飞书事件回调")
async def event(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    payload = await request.json()
    payload = _maybe_decrypt(payload)
    if payload is None:
        return _fail("decrypt failed")

    if payload.get("type") == "url_verification" and payload.get("challenge"):
        return JSONResponse(status_code=200, content={"challenge": payload["challenge"]})

    try:
        callback = FeishuEventCallback.model_validate(payload)
    except ValidationError:
        log.exception("Invalid Feishu event payload")
        return _fail("invalid payload")

    database = request.app.state.connections.mongo[get_settings().mongo_database]
    background_tasks.add_task(
        FeishuEventService.process_callback,
        callback=callback,
        database=database,
        redis_client=request.app.state.connections.redis,
    )
    return JSONResponse(status_code=200, content={"code": 0, "msg": "success"})


def _maybe_decrypt(payload: dict[str, Any]) -> dict[str, Any] | None:
    encrypt = payload.get("encrypt")
    if not encrypt:
        return payload
    if not isinstance(encrypt, str):
        return None
    return decrypt_feishu_payload(encrypt)


def _fail(msg: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 1, "msg": msg})
