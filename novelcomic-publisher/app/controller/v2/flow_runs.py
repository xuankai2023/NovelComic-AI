"""Workflow run 命令和事件连接。"""

import asyncio
import hashlib
import json
import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.common.context.request_context import RequestContext
from app.config import get_settings
from app.database.mongo import FLOW_TASK
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.workflow_runs_v2 import (
    CancelWorkflowRunRequest,
    ContinueWorkflowRunRequest,
    CreateWorkflowRunRequest,
    WorkflowRunResponse,
)
from app.services.jwt import JwtAuthenticationError, JwtService
from app.services.workflow_event_store import WorkflowEventStore
from app.services.workflow_runs_v2 import (
    ACTIVE_RUN_STATUSES,
    TERMINAL_RUN_STATUSES,
    WorkflowRunConflict,
    WorkflowRunInvalid,
    WorkflowRunV2Service,
)
from app.services.workflow_snapshot_client import (
    WorkflowSnapshotClient,
    WorkflowSnapshotUnavailable,
)
from app.utils.id_utils import generate_trace_id

router = APIRouter()
logger = logging.getLogger(__name__)
_NOT_FOUND = 1010
_UNAUTHORIZED = 1002
_CONFLICT = 1009
_INVALID = 1000
_REDIS_CURSOR_RE = re.compile(r"^\d+-\d+$")
_WS_AUTH_TIMEOUT_SECONDS = 15
_WS_ATTACH_TIMEOUT_SECONDS = 15
_WS_CLOSE_AUTH_FAILED = 4401
_WS_CLOSE_RUN_NOT_FOUND = 4404
_WS_CLOSE_INVALID_PROTOCOL = 4400
_WS_CLOSE_CURSOR_EXPIRED = 4409
_WS_CLOSE_CONNECTION_REPLACED = 4001
_WS_CLOSE_INTERNAL_ERROR = 1011


class WorkflowConnectionReplaced(Exception):
    """Raised when another socket has claimed the same flow task connection."""


def _ok(data: dict[str, Any] | list[dict[str, Any]], status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": 200, "msg": "ok", "data": data})


def _fail(msg: str, http_code: int, code: int) -> JSONResponse:
    return JSONResponse(status_code=http_code, content={"code": code, "msg": msg, "data": None})


def _dump_run(run: dict[str, Any]) -> dict[str, Any]:
    run.setdefault("trace_id", "")
    run.setdefault("idempotent_replay", False)
    return WorkflowRunResponse(**run).model_dump(mode="json")


async def _get_run(database: Any, user_id: str, flow_task_id: str) -> dict[str, Any] | None:
    return await database[FLOW_TASK].find_one(
        {"flow_task_id": flow_task_id, "user_id": user_id},
        {"_id": 0, "user_id": 0},
    )


def _workflow_message_type(message: dict[str, Any]) -> str:
    return str(message.get("event_type") or message.get("type") or "")


async def _safe_ws_close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except RuntimeError:
        return


async def _send_resume_error(
    websocket: WebSocket,
    *,
    code: str,
    message: str,
    flow_task_id: str,
    reason: str | None = None,
) -> None:
    try:
        payload = {
            "code": code,
            "event_type": "resume_error",
            "flow_task_id": flow_task_id,
            "message": message,
            "msg": message,
            "protocol_version": 2,
        }
        if reason:
            payload["reason"] = reason
        await websocket.send_json(payload)
    except RuntimeError:
        return


def _decode_redis_value(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


class _WorkflowEventConnectionRegistry:
    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _ensure_loop(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._loop is not loop or self._lock is None:
            self._loop = loop
            self._lock = asyncio.Lock()
            self._events = {}
        return self._lock

    async def wait(self, flow_task_id: str, wait_timeout: float) -> bool:
        lock = self._ensure_loop()
        async with lock:
            event = self._events.setdefault(flow_task_id, asyncio.Event())
            if event.is_set():
                event.clear()
                return True
        try:
            await asyncio.wait_for(event.wait(), timeout=wait_timeout)
        except TimeoutError:
            return False
        event.clear()
        return True

    async def notify(self, flow_task_id: str) -> None:
        lock = self._ensure_loop()
        async with lock:
            self._events.setdefault(flow_task_id, asyncio.Event()).set()


_WORKFLOW_EVENT_CONNECTIONS = _WorkflowEventConnectionRegistry()
_workflow_sockets: dict[tuple[str, str], WebSocket] = {}
_workflow_sockets_lock = asyncio.Lock()


async def _register_workflow_connection(
    flow_task_id: str,
    connection_id: str,
    websocket: WebSocket,
) -> WebSocket | None:
    key = (flow_task_id, connection_id)
    async with _workflow_sockets_lock:
        previous = _workflow_sockets.get(key)
        _workflow_sockets[key] = websocket
        if previous is websocket:
            return None
        return previous


async def _unregister_workflow_connection(
    flow_task_id: str,
    connection_id: str,
    websocket: WebSocket,
) -> None:
    key = (flow_task_id, connection_id)
    async with _workflow_sockets_lock:
        if _workflow_sockets.get(key) is websocket:
            _workflow_sockets.pop(key, None)


async def _claim_workflow_connection(
    flow_task_id: str,
    connection_id: str,
    websocket: WebSocket,
) -> None:
    previous = await _register_workflow_connection(flow_task_id, connection_id, websocket)
    if previous is not None:
        await _safe_ws_close(previous, _WS_CLOSE_CONNECTION_REPLACED)


async def workflow_event_notification_listener_forever(redis_client: Any) -> None:
    last_id = "0-0"
    while True:
        try:
            notifications = await redis_client.xread(
                {WorkflowEventStore.NOTIFICATION_STREAM: last_id},
                block=1000,
                count=100,
            )
            for _stream_name, entries in notifications:
                for notification_id, fields in entries:
                    last_id = _decode_redis_value(notification_id)
                    flow_task_id = fields.get(b"flow_task_id") or fields.get("flow_task_id")
                    if flow_task_id:
                        await _WORKFLOW_EVENT_CONNECTIONS.notify(_decode_redis_value(flow_task_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("workflow event notification listener failed")
            await asyncio.sleep(1)


def _ensure_workflow_event_listener(websocket: WebSocket) -> None:
    task = getattr(websocket.app.state, "workflow_v2_event_listener_task", None)
    if task is not None and not task.done():
        return
    websocket.app.state.workflow_v2_event_listener_task = asyncio.create_task(
        workflow_event_notification_listener_forever(websocket.app.state.connections.redis)
    )


async def _send_workflow_events(
    websocket: WebSocket,
    events: list[dict[str, Any]],
    *,
    redis_client: Any,
    flow_task_id: str,
    connection_id: str,
    generation: int,
    replayed: bool,
) -> str | None:
    last_cursor: str | None = None
    for event in events:
        if not await WorkflowEventStore.is_current_generation(
            redis_client,
            flow_task_id,
            connection_id,
            generation,
        ):
            await _safe_ws_close(websocket, _WS_CLOSE_CONNECTION_REPLACED)
            raise WorkflowConnectionReplaced
        last_cursor = str(event.get("cursor") or last_cursor or "")
        await websocket.send_json(
            {
                "cursor": last_cursor,
                "event_cursor": last_cursor,
                "event": event,
                "event_type": "workflow_event",
                "flow_task_id": event.get("flow_task_id"),
                "payload": event.get("payload") or {},
                "protocol_version": 2,
                "replayed": replayed,
                "type": "event",
            }
        )
    return last_cursor


async def _receive_loop(websocket: WebSocket) -> None:
    while True:
        raw = await websocket.receive_text()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        msg_type = _workflow_message_type(payload)
        if msg_type == "ping":
            await websocket.send_json(
                {
                    "event_type": "pong",
                    "protocol_version": 2,
                    "type": "pong",
                }
            )


async def _event_loop(
    websocket: WebSocket,
    *,
    database: Any,
    redis_client: Any,
    flow_task_id: str,
    connection_id: str,
    generation: int,
    cursor: str | None,
) -> None:
    current_cursor = cursor
    while True:
        if not await WorkflowEventStore.is_current_generation(
            redis_client,
            flow_task_id,
            connection_id,
            generation,
        ):
            await _safe_ws_close(websocket, _WS_CLOSE_CONNECTION_REPLACED)
            raise WorkflowConnectionReplaced
        events = await WorkflowEventStore.read_live(
            database,
            flow_task_id,
            current_cursor,
            redis_client=redis_client,
            block_ms=5000,
        )
        if not events:
            await _WORKFLOW_EVENT_CONNECTIONS.wait(flow_task_id, wait_timeout=2)
            continue
        next_cursor = await _send_workflow_events(
            websocket,
            events,
            redis_client=redis_client,
            flow_task_id=flow_task_id,
            connection_id=connection_id,
            generation=generation,
            replayed=False,
        )
        current_cursor = next_cursor or current_cursor


@router.post("/runs", summary="创建 workflow run")
async def create_workflow_run(
    body: CreateWorkflowRunRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        run = await WorkflowRunV2Service.create_run(
            database=database,
            redis_client=request.app.state.connections.redis,
            request=body,
            user_id=user.user_id,
        )
    except WorkflowRunInvalid as exc:
        return _fail(str(exc), 422, _INVALID)
    except WorkflowRunConflict as exc:
        return _fail(str(exc), 409, _CONFLICT)
    return _ok(run.model_dump(mode="json"), 202)


@router.post("/runs/{flow_task_id}/continue", summary="继续 workflow run")
async def continue_workflow_run(
    flow_task_id: str,
    body: ContinueWorkflowRunRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        run = await WorkflowRunV2Service.continue_run(
            database=database,
            redis_client=request.app.state.connections.redis,
            user_id=user.user_id,
            flow_task_id=flow_task_id,
            request=body,
        )
    except WorkflowRunInvalid as exc:
        return _fail(str(exc), 422, _INVALID)
    except WorkflowRunConflict as exc:
        if str(exc) == "workflow run not found":
            return _fail("Workflow run not found", 404, _NOT_FOUND)
        return _fail(str(exc), 409, _CONFLICT)
    return _ok(run.model_dump(mode="json"), 202)


@router.post("/runs/{flow_task_id}/cancel", summary="取消 workflow run")
async def cancel_workflow_run(
    flow_task_id: str,
    body: CancelWorkflowRunRequest,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    try:
        run = await WorkflowRunV2Service.cancel_run(
            database=database,
            redis_client=request.app.state.connections.redis,
            user_id=user.user_id,
            flow_task_id=flow_task_id,
            command_id=body.command_id,
        )
    except WorkflowRunInvalid as exc:
        return _fail(str(exc), 422, _INVALID)
    except WorkflowRunConflict as exc:
        if str(exc) == "workflow run not found":
            return _fail("Workflow run not found", 404, _NOT_FOUND)
        return _fail(str(exc), 409, _CONFLICT)
    return _ok(run.model_dump(mode="json"), 202)


@router.get("/runs", summary="查询 workflow run 列表")
async def list_workflow_runs(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    flow_id: str = Query(...),
    status: str | None = Query(default=None),
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    query: dict[str, Any] = {"flow_id": flow_id, "user_id": user.user_id}
    if status == "active":
        query["status"] = {"$in": list(ACTIVE_RUN_STATUSES)}
    elif status:
        query["status"] = status

    runs: list[dict[str, Any]] = []
    cursor = database[FLOW_TASK].find(query, {"_id": 0, "user_id": 0}).sort("created_at", -1)
    async for run in cursor:
        runs.append(_dump_run(run))
    return _ok(runs)


@router.get("/runs/{flow_task_id}", summary="查询 workflow run")
async def get_workflow_run(
    flow_task_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = request.app.state.connections.mongo[get_settings().mongo_database]
    run = await _get_run(database, user.user_id, flow_task_id)
    if run is None:
        return _fail("Workflow run not found", 404, _NOT_FOUND)
    return _ok(_dump_run(run))


@router.websocket("/runs/{flow_task_id}/events/{connection_id}")
async def workflow_run_events(
    websocket: WebSocket,
    flow_task_id: str,
    connection_id: str,
) -> None:
    await websocket.accept()
    socket_trace_id = generate_trace_id()
    RequestContext.set_trace_id(socket_trace_id)
    logger.info(
        "workflow v2 events accepted flow_task_id=%s connection_id=%s trace_id=%s",
        flow_task_id,
        connection_id,
        socket_trace_id,
    )
    database = websocket.app.state.connections.mongo[get_settings().mongo_database]
    redis_client = websocket.app.state.connections.redis
    registered = False

    try:
        try:
            auth_message = await asyncio.wait_for(
                websocket.receive_json(),
                timeout=_WS_AUTH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            await _send_resume_error(
                websocket,
                code="AUTH_REQUIRED",
                message="Timed out waiting for auth message",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_AUTH_FAILED)
            return
        if not isinstance(auth_message, dict):
            await _send_resume_error(
                websocket,
                code="AUTH_REQUIRED",
                message="auth message must be a JSON object",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_AUTH_FAILED)
            return
        if _workflow_message_type(auth_message) != "auth":
            await _send_resume_error(
                websocket,
                code="AUTH_REQUIRED",
                message="auth message is required before attach_flow",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_AUTH_FAILED)
            return
        if int(auth_message.get("protocol_version") or 0) != 2:
            await _send_resume_error(
                websocket,
                code="INVALID_PROTOCOL",
                message="protocol_version=2 is required",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return

        token = (
            auth_message.get("token")
            or auth_message.get("userToken")
            or auth_message.get("user_token")
        )
        if not token:
            await _send_resume_error(
                websocket,
                code="AUTH_REQUIRED",
                message="JWT token is required",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_AUTH_FAILED)
            return
        token = str(token)
        if token.startswith("Bearer "):
            token = token[len("Bearer ") :]

        try:
            user_id = await JwtService.get_user_id_with_backoff(token=token)
        except JwtAuthenticationError:
            await _send_resume_error(
                websocket,
                code="AUTH_FAILED",
                message="Invalid token",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_AUTH_FAILED)
            return

        run = await WorkflowRunV2Service.get_run_summary(
            database=database,
            user_id=user_id,
            flow_task_id=flow_task_id,
        )
        if run is None:
            await _send_resume_error(
                websocket,
                code="RUN_NOT_FOUND",
                message="Workflow run not found",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_RUN_NOT_FOUND)
            return

        await websocket.send_json(
            {
                "connection_id": connection_id,
                "event_type": "authenticated",
                "flow_task_id": flow_task_id,
                "flow_run_id": run.flow_run_id,
                "protocol_version": 2,
                "type": "authenticated",
            }
        )

        attach_message = await asyncio.wait_for(
            websocket.receive_json(),
            timeout=_WS_ATTACH_TIMEOUT_SECONDS,
        )
        if not isinstance(attach_message, dict):
            await _send_resume_error(
                websocket,
                code="INVALID_ATTACH",
                message="attach_flow message must be a JSON object",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return
        if _workflow_message_type(attach_message) != "attach_flow":
            await _send_resume_error(
                websocket,
                code="ATTACH_REQUIRED",
                message="attach_flow message is required after authentication",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return
        if attach_message.get("flow_task_id") not in (None, flow_task_id):
            await _send_resume_error(
                websocket,
                code="INVALID_ATTACH",
                message="attach_flow flow_task_id does not match URL",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return
        if attach_message.get("connection_id") not in (None, connection_id):
            await _send_resume_error(
                websocket,
                code="INVALID_ATTACH",
                message="attach_flow connection_id does not match URL",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return

        cursor = (
            attach_message.get("last_event_cursor")
            or attach_message.get("event_cursor")
            or attach_message.get("cursor")
            or "0-0"
        )
        cursor = str(cursor)
        if not _REDIS_CURSOR_RE.match(cursor):
            await _send_resume_error(
                websocket,
                code="INVALID_CURSOR",
                message="Invalid workflow event cursor",
                flow_task_id=flow_task_id,
            )
            await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
            return
        snapshot = None
        if not await WorkflowEventStore.is_cursor_available(
            flow_task_id,
            cursor,
            redis_client=redis_client,
            database=database,
        ):
            snapshot_cursor = await WorkflowEventStore.latest_cursor(
                flow_task_id,
                redis_client=redis_client,
            )
            try:
                snapshot = await WorkflowSnapshotClient.fetch(flow_task_id)
            except WorkflowSnapshotUnavailable:
                await _send_resume_error(
                    websocket,
                    code="RESUME_WINDOW_EXPIRED",
                    message="Workflow event cursor is outside the replay window",
                    flow_task_id=flow_task_id,
                    reason="cursor_expired",
                )
                await _safe_ws_close(websocket, _WS_CLOSE_CURSOR_EXPIRED)
                return
            cursor = snapshot_cursor
        generation = await WorkflowEventStore.claim_connection_generation(
            redis_client,
            flow_task_id,
            connection_id,
        )
        await _claim_workflow_connection(flow_task_id, connection_id, websocket)
        registered = True
        high_watermark = await WorkflowEventStore.latest_cursor(
            flow_task_id,
            redis_client=redis_client,
        )
        if snapshot is not None:
            if not await WorkflowEventStore.is_current_generation(
                redis_client,
                flow_task_id,
                connection_id,
                generation,
            ):
                await _safe_ws_close(websocket, _WS_CLOSE_CONNECTION_REPLACED)
                raise WorkflowConnectionReplaced
            snapshot_digest = hashlib.sha256(
                json.dumps(snapshot, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()[:24]
            await websocket.send_json(
                {
                    "event_cursor": cursor,
                    "event_id": f"snapshot-{snapshot_digest}",
                    "event_type": "flow_snapshot",
                    "flow_run_id": snapshot.get("flow_run_id") or run.flow_run_id,
                    "flow_task_id": flow_task_id,
                    "protocol_version": 2,
                    "replayed": True,
                    "snapshot": snapshot,
                    "status": run.status,
                }
            )
        events = await WorkflowEventStore.replay_after(
            database,
            flow_task_id,
            cursor,
            redis_client=redis_client,
            through_cursor=high_watermark,
        )
        await _send_workflow_events(
            websocket,
            events,
            redis_client=redis_client,
            flow_task_id=flow_task_id,
            connection_id=connection_id,
            generation=generation,
            replayed=True,
        )
        refreshed = await WorkflowRunV2Service.get_run_summary(
            database=database,
            user_id=user_id,
            flow_task_id=flow_task_id,
        )
        if refreshed is not None:
            run = refreshed
        if run.status in TERMINAL_RUN_STATUSES:
            terminal_watermark = await WorkflowEventStore.latest_cursor(
                flow_task_id,
                redis_client=redis_client,
            )
            terminal_events = await WorkflowEventStore.replay_after(
                database,
                flow_task_id,
                high_watermark,
                redis_client=redis_client,
                through_cursor=terminal_watermark,
            )
            await _send_workflow_events(
                websocket,
                terminal_events,
                redis_client=redis_client,
                flow_task_id=flow_task_id,
                connection_id=connection_id,
                generation=generation,
                replayed=True,
            )
            high_watermark = terminal_watermark
        if not await WorkflowEventStore.is_current_generation(
            redis_client,
            flow_task_id,
            connection_id,
            generation,
        ):
            await _safe_ws_close(websocket, _WS_CLOSE_CONNECTION_REPLACED)
            raise WorkflowConnectionReplaced
        await websocket.send_json(
            {
                "connection_id": connection_id,
                "cursor": high_watermark,
                "event_cursor": high_watermark,
                "event_type": "resume_ready",
                "flow_run_id": run.flow_run_id,
                "flow_task_id": flow_task_id,
                "latest_event_cursor": high_watermark,
                "protocol_version": 2,
                "status": run.status,
            }
        )

        event_task = asyncio.create_task(
            _event_loop(
                websocket,
                database=database,
                redis_client=redis_client,
                flow_task_id=flow_task_id,
                connection_id=connection_id,
                generation=generation,
                cursor=high_watermark,
            )
        )
        receive_task = asyncio.create_task(_receive_loop(websocket))
        try:
            done, pending = await asyncio.wait(
                {event_task, receive_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        finally:
            for task in (event_task, receive_task):
                if not task.done():
                    task.cancel()
    except WebSocketDisconnect:
        return
    except WorkflowConnectionReplaced:
        return
    except TimeoutError:
        await _send_resume_error(
            websocket,
            code="INVALID_PROTOCOL",
            message="Timed out waiting for workflow WebSocket protocol message",
            flow_task_id=flow_task_id,
        )
        await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
    except ValueError as exc:
        await _send_resume_error(
            websocket,
            code="INVALID_PROTOCOL",
            message=str(exc),
            flow_task_id=flow_task_id,
        )
        await _safe_ws_close(websocket, _WS_CLOSE_INVALID_PROTOCOL)
    except Exception:
        logger.exception("workflow v2 websocket failed")
        await _send_resume_error(
            websocket,
            code="INTERNAL_ERROR",
            message="Workflow event connection failed",
            flow_task_id=flow_task_id,
        )
        await _safe_ws_close(websocket, _WS_CLOSE_INTERNAL_ERROR)
    finally:
        if registered:
            await _unregister_workflow_connection(flow_task_id, connection_id, websocket)
