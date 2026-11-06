"""Agent run API and resumable SSE endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import jwt
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from novelcomic_agent.config import Settings, get_settings
from novelcomic_agent.core.loop import AgentLoop, AgentRunInput
from novelcomic_agent.core.memory import connect_memory
from novelcomic_agent.core.tools.workflow_snapshot import apply_request_workflow_snapshot
from novelcomic_agent.dao.workflow_dao import WorkflowDAO
from novelcomic_agent.legacy import note_legacy_agent_chat
from novelcomic_agent.services.agent_redis_run_store import (
    RedisRunStore,
    ResumeWindowExpiredError,
)
from novelcomic_agent.session.manager import SessionManager
from novelcomic_agent.workflow.event_bridge import get_run_snapshot
from novelcomic_agent.workflow.generation_confirm import get_pending_generation

AGENT_MODEL_PRESETS: list[dict[str, Any]] = [
    {
        "id": "deepseek_v4_flash",
        "label": "Fast · DeepSeek V4 Flash",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "is_default": True,
    },
    {
        "id": "claude",
        "label": "Balanced · Claude Sonnet",
        "provider": "anthropic",
        "model": "claude-sonnet-4",
        "is_default": False,
    },
    {
        "id": "kimi_k3",
        "label": "Deep · Kimi K3",
        "provider": "moonshot",
        "model": "kimi-k3",
        "is_default": False,
    },
]

ACTIVE_RUN_STATUSES = {"queued", "running", "waiting_hitl"}
TASK_BACKED_RUN_STATUSES = {"queued", "running"}
TERMINAL_EVENTS = {"run.completed", "run.failed", "run.cancelled"}
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

_running_run_tasks: dict[str, asyncio.Task[Any]] = {}
_LOCAL_PREVIEW_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
_TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled", "interrupted"})
_SCAN_RUN_STATUSES = frozenset({"running", "queued"})
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SlotTiming:
    """Clocks for the blue/green heartbeat, orphan scan, and shutdown drain."""

    heartbeat_interval: float = 3
    heartbeat_ttl: int = 10
    scan_initial_delay: float = 15
    scan_interval: float = 10
    drain_timeout: float = 90


@dataclass(slots=True)
class AgentSlot:
    instance_id: str
    heartbeat: asyncio.Task[None]
    scanner: asyncio.Task[None]
    timing: SlotTiming


def make_instance_id() -> str:
    """Slot identity is this process plus 8 hex characters."""

    return f"{os.getpid()}_{uuid4().hex[:8]}"


async def heartbeat_loop(
    app: Any,
    store: RedisRunStore,
    instance_id: str,
    *,
    interval: float,
    ttl: int,
) -> None:
    """Refresh the owner heartbeat until drain sets ``shutting_down``."""

    while not getattr(app.state, "shutting_down", False):
        await store.refresh_instance_heartbeat(instance_id, ttl_seconds=ttl)
        await asyncio.sleep(interval)


async def orphan_scan_loop(
    app: Any,
    store: RedisRunStore,
    *,
    initial_delay: float,
    interval: float,
) -> None:
    """Wait once, then keep scanning ``agent:active_runs``."""

    await asyncio.sleep(initial_delay)
    while not getattr(app.state, "shutting_down", False):
        await scan_orphaned_runs(app, store)
        await asyncio.sleep(interval)


async def scan_orphaned_runs(app: Any, store: RedisRunStore) -> None:
    """Resume a dead owner's run when its checkpoint is still in Redis."""

    try:
        active_run_ids = await store.get_active_runs()
    except Exception:
        logger.exception("agent orphan scan failed")
        return
    instance_id = getattr(app.state, "instance_id", "") or make_instance_id()
    app.state.instance_id = instance_id
    for run_id in active_run_ids:
        try:
            await _consider_orphaned_run(app, store, run_id, instance_id)
        except Exception:
            logger.exception("agent orphan scan failed for %s", run_id)


async def _consider_orphaned_run(
    app: Any,
    store: RedisRunStore,
    run_id: str,
    instance_id: str,
) -> None:
    if run_id in _running_run_tasks:
        return
    meta = await store.get_run_meta(run_id)
    if not meta:
        await store.remove_active_run(run_id)
        return
    if meta.get("status") not in _SCAN_RUN_STATUSES:
        await store.remove_active_run(run_id)
        return
    owner = meta.get("owner_instance", "")
    if not owner or await store.is_instance_alive(owner):
        return
    checkpoint = await store.read_checkpoint(run_id)
    if not checkpoint:
        await _mark_run_interrupted(store, run_id, meta)
        return
    await _resume_agent_run(app, store, run_id, checkpoint, instance_id)


async def _mark_run_interrupted(
    store: RedisRunStore,
    run_id: str,
    meta: dict[str, str] | None = None,
) -> None:
    current = meta if meta is not None else await store.get_run_meta(run_id)
    if not current:
        await store.remove_active_run(run_id)
        return
    await store.append_event(
        run_id,
        "run.failed",
        {"run_id": run_id, "error": "RUNNER_INTERRUPTED"},
    )
    await store.mark_status(run_id, "interrupted")
    await store.remove_active_run(run_id)


async def _resume_agent_run(
    app: Any,
    store: RedisRunStore,
    run_id: str,
    checkpoint: dict[str, Any],
    instance_id: str,
) -> None:
    await store.set_owner_instance(run_id, instance_id)
    hook = getattr(app.state, "resume_agent_run", None)

    async def _work() -> None:
        if hook is not None:
            await hook(run_id, checkpoint)
            return
        await _resume_with_agent_loop(app, run_id, checkpoint)

    _track_run_task(app, store, run_id, _work())


async def _resume_with_agent_loop(app: Any, run_id: str, checkpoint: dict[str, Any]) -> None:
    message = checkpoint.get("message")
    session_id = str(checkpoint.get("session_id") or "")
    user_id = str(checkpoint.get("user_id") or "")
    if not isinstance(message, str) or not message or not session_id or not user_id:
        await _mark_run_interrupted(_run_store_from_app(app), run_id)
        return
    settings = getattr(app.state, "settings", None) or get_settings()
    dependencies = app.state.dependencies
    database = dependencies.mongo[settings.mongodb_database]
    redis_client = getattr(dependencies, "redis", None)
    loop = AgentLoop(
        session_manager=_session_manager_from_app(app, settings),
        run_store=_run_store_from_app(app),
        llm_client=getattr(dependencies, "llm_client", None),
        workflow_dao=WorkflowDAO(database["flow"]),
        redis_client=redis_client,
        templates_col=database["templates"],
        share_flow_col=database["share_flow"],
    )
    raw_metadata = checkpoint.get("metadata")
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    await loop.run(
        AgentRunInput(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            flow_id=str(checkpoint.get("flow_id") or ""),
            message=message,
            client_request_id=str(checkpoint.get("client_request_id") or run_id),
            metadata=metadata,
        )
    )


async def _run_reached_terminal(store: RedisRunStore, run_id: str) -> bool:
    try:
        meta = await store.get_run_meta(run_id)
    except Exception:
        return False
    return meta.get("status") in _TERMINAL_RUN_STATUSES


def _track_run_task(
    _app: Any,
    store: RedisRunStore,
    run_id: str,
    work: Awaitable[Any],
) -> asyncio.Task[Any]:
    async def guarded() -> None:
        reached_terminal = False
        try:
            await work
        except asyncio.CancelledError:
            reached_terminal = await _run_reached_terminal(store, run_id)
            raise
        else:
            reached_terminal = await _run_reached_terminal(store, run_id)
        finally:
            _running_run_tasks.pop(run_id, None)
            if reached_terminal:
                try:
                    await store.delete_checkpoint(run_id)
                    await store.remove_active_run(run_id)
                except Exception:
                    logger.exception("agent checkpoint cleanup failed for %s", run_id)

    task = asyncio.create_task(guarded(), name=f"agent-run:{run_id}")
    _running_run_tasks[run_id] = task
    return task


async def start_agent_slot(app: Any, *, timing: SlotTiming | None = None) -> AgentSlot:
    """Start the instance heartbeat and the orphan scan."""

    clocks = timing or SlotTiming()
    instance_id = make_instance_id()
    app.state.instance_id = instance_id
    app.state.shutting_down = False
    store = _run_store_from_app(app)
    slot = AgentSlot(
        instance_id=instance_id,
        heartbeat=asyncio.create_task(
            heartbeat_loop(
                app,
                store,
                instance_id,
                interval=clocks.heartbeat_interval,
                ttl=clocks.heartbeat_ttl,
            )
        ),
        scanner=asyncio.create_task(
            orphan_scan_loop(
                app,
                store,
                initial_delay=clocks.scan_initial_delay,
                interval=clocks.scan_interval,
            )
        ),
        timing=clocks,
    )
    app.state.agent_slot = slot
    return slot


async def stop_agent_slot(app: Any, *, drain_timeout: float | None = None) -> None:
    """Stop heartbeats, wait for in-flight runs, and keep non-terminal checkpoints."""

    app.state.shutting_down = True
    slot = getattr(app.state, "agent_slot", None)
    if slot is not None:
        slot.heartbeat.cancel()
        slot.scanner.cancel()
        await asyncio.gather(slot.heartbeat, slot.scanner, return_exceptions=True)
    timeout = drain_timeout
    if timeout is None and slot is not None:
        timeout = slot.timing.drain_timeout
    if timeout is None:
        timeout = SlotTiming().drain_timeout
    if timeout > 0 and _running_run_tasks:
        await asyncio.wait(set(_running_run_tasks.values()), timeout=timeout)
    pending = [task for task in list(_running_run_tasks.values()) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


def _require_local_preview(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in _LOCAL_PREVIEW_HOSTS:
        raise HTTPException(status_code=404, detail="Not Found")


@dataclass(slots=True)
class AuthenticatedAgentUser:
    user_id: str
    token: str


class AgentRunRequest(BaseModel):
    """Request body for one task-backed Agent run."""

    model_config = ConfigDict(extra="allow")

    message: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    flow_id: str | None = None
    user_id: str | None = None
    agent_model: str | None = None
    client_request_id: str | None = None
    client_request_sent_at_utc_ms: int | float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    workflow_snapshot: dict[str, Any] | None = None
    stream: bool = True


class AgentRunCancelByRequest(BaseModel):
    session_id: str = Field(min_length=1)
    client_request_id: str = Field(min_length=1)
    user_id: str | None = None


class StopRequest(BaseModel):
    session_id: str = Field(min_length=1)


class WorkflowSelectRequest(BaseModel):
    flow_task_id: str = Field(min_length=1)


class GenerationConfirmRequest(BaseModel):
    confirm_id: str = Field(min_length=1)


class SessionFeedbackRequest(BaseModel):
    turn: int = Field(ge=1)
    rating: str = Field(min_length=1)
    comment: str | None = None


def create_agent_router(settings: Settings | None = None) -> APIRouter:
    """Create the Agent API router without mutating the application entrypoint."""

    resolved_settings = settings or get_settings()
    memory = connect_memory(resolved_settings)
    if memory is not None:
        logger.info("mem0 connected")
    router = APIRouter(tags=["agent"])

    def authenticate(
        authorization: str | None,
        requested_user_id: str | None = None,
    ) -> AuthenticatedAgentUser:
        return _authenticate_agent_user(
            authorization=authorization,
            requested_user_id=requested_user_id,
            settings=resolved_settings,
        )

    @router.post("/v1/agent/runs")
    async def create_agent_run(
        body: AgentRunRequest,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        if getattr(request.app.state, "shutting_down", False):
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "INSTANCE_SHUTTING_DOWN",
                    "message": "服务正在切换，请稍后重试",
                },
            )
        user = authenticate(authorization, x_user_id or body.user_id)
        run_store = _run_store(request)

        client_request_id = body.client_request_id or f"req_{uuid4().hex[:16]}"
        existing_run_id = await run_store.get_run_id_for_request(
            user_id=user.user_id,
            session_id=body.session_id,
            client_request_id=client_request_id,
        )
        if existing_run_id:
            meta = await run_store.get_run_meta(existing_run_id)
            return _json(
                {
                    "run_id": existing_run_id,
                    "status": meta.get("status", "queued"),
                    "created": False,
                }
            )

        owner = f"create:{uuid4().hex}"
        if not await run_store.acquire_session_run_lock(body.session_id, owner):
            raise HTTPException(status_code=409, detail={"code": "SESSION_RUN_LOCKED"})

        try:
            active_run_id = await _active_task_backed_run_id(run_store, body.session_id)
            if active_run_id:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "ACTIVE_RUN_EXISTS", "active_run_id": active_run_id},
                )

            request_payload = body.model_dump()
            workflow_snapshot = apply_request_workflow_snapshot(request_payload, body.flow_id)
            created = await run_store.create_run(
                user_id=user.user_id,
                session_id=body.session_id,
                flow_id=body.flow_id or "",
                client_request_id=client_request_id,
                request=request_payload,
            )
            if created.created:
                await _start_agent_run_task(
                    request=request,
                    settings=resolved_settings,
                    user_id=user.user_id,
                    run_id=created.run_id,
                    client_request_id=client_request_id,
                    body=body,
                    workflow_snapshot=workflow_snapshot,
                )

            return _json(
                {"run_id": created.run_id, "status": "queued", "created": created.created},
                status_code=202 if created.created else 200,
            )
        finally:
            await run_store.release_session_run_lock(body.session_id, owner)

    @router.get("/v1/agent/runs/{run_id}/events")
    async def stream_agent_run_events(
        run_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> StreamingResponse:
        user = authenticate(authorization, x_user_id)
        run_store = _run_store(request)
        await _require_owned_run(run_store, run_id, user.user_id)
        cursor = last_event_id or "0-0"
        try:
            await run_store.ensure_resume_available(run_id, last_event_id=cursor)
        except ResumeWindowExpiredError as exc:
            raise HTTPException(
                status_code=410,
                detail={
                    "code": "RESUME_WINDOW_EXPIRED",
                    "run_id": exc.run_id,
                    "earliest_event_id": exc.earliest_event_id,
                },
            ) from exc

        async def event_stream() -> AsyncIterator[str]:
            current_cursor = cursor
            while True:
                if await request.is_disconnected():
                    return
                try:
                    items = await run_store.read_events(
                        run_id,
                        last_event_id=current_cursor,
                        block_ms=15_000,
                    )
                except ResumeWindowExpiredError:
                    yield _format_sse_event(
                        event_name="agent.failed",
                        data={"error": "RESUME_WINDOW_EXPIRED", "code": "RESUME_WINDOW_EXPIRED"},
                    )
                    return

                if not items:
                    latest_meta = await run_store.get_run_meta(run_id)
                    if latest_meta.get("status") in {"completed", "failed", "cancelled"}:
                        # A terminal event can arrive after the empty read. Drain once
                        # so the subscriber still sees run.completed / run.cancelled.
                        tail = await run_store.read_events(run_id, last_event_id=current_cursor)
                        for item in tail:
                            current_cursor = item.redis_id
                            yield _format_sse_event(
                                event_id=item.redis_id,
                                event_name=item.event,
                                data=item.data,
                            )
                        return
                    yield _format_sse_comment("heartbeat")
                    continue

                for item in items:
                    current_cursor = item.redis_id
                    yield _format_sse_event(
                        event_id=item.redis_id,
                        event_name=item.event,
                        data=item.data,
                    )
                    if item.event in TERMINAL_EVENTS:
                        return

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    @router.get("/v1/agent/sessions/{session_id}/active-run")
    async def get_active_agent_run(
        session_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        run_store = _run_store(request)
        run_id = await run_store.get_active_run_id(session_id)
        if not run_id:
            return _json({"run_id": None, "status": "idle"})
        meta = await _require_owned_run(run_store, run_id, user.user_id)
        status = meta.get("status", "queued")
        if status not in ACTIVE_RUN_STATUSES:
            return _json({"run_id": None, "status": "idle"})
        return _json({"run_id": run_id, "status": status, "meta": meta})

    @router.post("/v1/agent/runs/{run_id}/cancel")
    async def cancel_agent_run(
        run_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        run_store = _run_store(request)
        meta = await _require_owned_run(run_store, run_id, user.user_id)
        await run_store.request_run_cancel(run_id)
        task = _running_run_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        return _json({"run_id": run_id, "session_id": meta.get("session_id"), "cancelled": True})

    @router.post("/v1/agent/runs/cancel-by-request")
    async def cancel_agent_run_by_request(
        body: AgentRunCancelByRequest,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id or body.user_id)
        run_store = _run_store(request)
        await run_store.mark_request_cancelled(
            user_id=user.user_id,
            session_id=body.session_id,
            client_request_id=body.client_request_id,
        )
        run_id = await run_store.get_run_id_for_request(
            user_id=user.user_id,
            session_id=body.session_id,
            client_request_id=body.client_request_id,
        )
        if run_id:
            await run_store.request_run_cancel(run_id)
            task = _running_run_tasks.get(run_id)
            if task and not task.done():
                task.cancel()
        return _json({"run_id": run_id, "cancelled": True})

    @router.get("/v1/agent/sessions")
    async def list_agent_sessions(
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
        limit: int = 20,
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        database = _database(request, resolved_settings)
        cursor = (
            database["agent_sessions"]
            .find({"user_id": user.user_id})
            .sort("updated_at", -1)
            .limit(max(1, min(limit, 100)))
        )
        sessions = []
        async for doc in cursor:
            doc.pop("_id", None)
            sessions.append(doc)
        return _json({"sessions": sessions})

    @router.get("/v1/agent/sessions/{session_id}/messages")
    async def get_agent_session_messages(
        session_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
        limit: int = 20,
        before_seq: int | None = None,
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        manager = _session_manager(request, resolved_settings)
        session = await manager.get_or_create(session_id)
        if session.user_id and session.user_id != user.user_id:
            raise HTTPException(status_code=403, detail={"code": "RUN_FORBIDDEN"})
        page = await manager.get_messages_page(
            session_id,
            limit=max(1, min(limit, 100)),
            before_seq=before_seq,
        )
        return _json(page)

    @router.get("/v1/agent/models")
    async def list_agent_models(
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        if authorization or x_user_id:
            authenticate(authorization, x_user_id)
        return _json(
            {
                "default_model": "deepseek_v4_flash",
                "models": [dict(item) for item in AGENT_MODEL_PRESETS],
            }
        )

    @router.put("/v1/agent/sessions/{session_id}/feedback")
    @router.post("/v1/agent/sessions/{session_id}/feedback")
    async def submit_agent_session_feedback(
        session_id: str,
        body: SessionFeedbackRequest,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        rating_map = {
            "like": "like",
            "positive": "like",
            "dislike": "dislike",
            "negative": "dislike",
        }
        normalized_rating = rating_map.get(body.rating.strip().lower())
        if not normalized_rating:
            raise HTTPException(status_code=422, detail={"code": "INVALID_RATING"})
        manager = _session_manager(request, resolved_settings)
        session = await manager.get_or_create(session_id)
        if session.user_id and session.user_id != user.user_id:
            raise HTTPException(status_code=403, detail={"code": "RUN_FORBIDDEN"})
        database = _database(request, resolved_settings)
        await database["agent_feedback"].update_one(
            {"session_id": session_id, "turn": body.turn, "user_id": user.user_id},
            {
                "$set": {
                    "session_id": session_id,
                    "turn": body.turn,
                    "user_id": user.user_id,
                    "rating": normalized_rating,
                    "comment": body.comment,
                }
            },
            upsert=True,
        )
        return _json(
            {
                "status": "ok",
                "session_id": session_id,
                "turn": body.turn,
                "rating": normalized_rating,
            }
        )

    @router.delete("/v1/agent/sessions/{session_id}/feedback")
    async def delete_agent_session_feedback(
        session_id: str,
        turn: int,
        request: Request,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        manager = _session_manager(request, resolved_settings)
        session = await manager.get_or_create(session_id)
        if session.user_id and session.user_id != user.user_id:
            raise HTTPException(status_code=403, detail={"code": "RUN_FORBIDDEN"})
        database = _database(request, resolved_settings)
        await database["agent_feedback"].delete_one(
            {"session_id": session_id, "turn": turn, "user_id": user.user_id}
        )
        return _json({"status": "deleted", "session_id": session_id, "turn": turn})

    @router.post("/v1/agent/chat")
    async def legacy_agent_chat() -> JSONResponse:
        note_legacy_agent_chat()
        return _json(
            {"code": "USE_AGENT_RUNS", "message": "Use POST /v1/agent/runs instead."},
            status_code=410,
        )

    @router.post("/api/v1/agent/chat/stop")
    async def legacy_agent_chat_stop() -> JSONResponse:
        note_legacy_agent_chat()
        return _json(
            {
                "code": "USE_AGENT_RUNS",
                "message": "Use POST /v1/agent/runs/{run_id}/cancel instead.",
            },
            status_code=410,
        )

    @router.post("/v1/agent/workflow/select")
    async def workflow_select(
        body: WorkflowSelectRequest,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        authenticate(authorization, x_user_id)
        snapshot = get_run_snapshot(body.flow_task_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail={"code": "SNAPSHOT_NOT_FOUND"})
        return _json(
            {
                "flow_task_id": snapshot.flow_task_id,
                "ws_id": snapshot.ws_id,
                "nodes": snapshot.nodes,
                "edges": snapshot.edges,
                "session_id": snapshot.session_id,
                "flow_id": snapshot.flow_id,
            }
        )

    @router.post("/v1/agent/generation/confirm")
    async def generation_confirm(
        body: GenerationConfirmRequest,
        authorization: str | None = Header(default=None),
        x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    ) -> JSONResponse:
        user = authenticate(authorization, x_user_id)
        pending = get_pending_generation(body.confirm_id)
        if pending is None:
            raise HTTPException(status_code=404, detail={"code": "CONFIRM_NOT_FOUND"})
        if pending.user_id != user.user_id:
            raise HTTPException(status_code=403, detail={"code": "CONFIRM_FORBIDDEN"})
        return _json({"confirm_id": pending.confirm_id, "status": "confirmed"})

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/preview/active_runs")
    async def preview_active_runs(request: Request) -> dict[str, Any]:
        _require_local_preview(request)
        return {
            "count": len(_running_run_tasks),
            "run_ids": list(_running_run_tasks),
            "shutting_down": bool(getattr(request.app.state, "shutting_down", False)),
        }

    @router.post("/preview/drain")
    async def preview_drain(request: Request) -> dict[str, Any]:
        _require_local_preview(request)
        was_already = bool(getattr(request.app.state, "shutting_down", False))
        request.app.state.shutting_down = True
        return {
            "shutting_down": True,
            "was_already_draining": was_already,
            "active_runs": len(_running_run_tasks),
        }

    return router


async def _start_agent_run_task(
    *,
    request: Request,
    settings: Settings,
    user_id: str,
    run_id: str,
    client_request_id: str,
    body: AgentRunRequest,
    workflow_snapshot: dict[str, Any] | None,
) -> None:
    dependencies = request.app.state.dependencies
    database = _database(request, settings)
    redis_client = _redis(request)
    run_store = _run_store(request)
    loop = AgentLoop(
        session_manager=_session_manager(request, settings),
        run_store=run_store,
        llm_client=getattr(dependencies, "llm_client", None),
        workflow_dao=WorkflowDAO(database["flow"]),
        redis_client=redis_client,
        templates_col=database["templates"],
        share_flow_col=database["share_flow"],
    )
    run_input = AgentRunInput(
        user_id=user_id,
        session_id=body.session_id,
        run_id=run_id,
        flow_id=body.flow_id or "",
        message=body.message,
        client_request_id=client_request_id,
        workflow_snapshot=workflow_snapshot,
        metadata=body.metadata,
        agent_model=body.agent_model,
    )
    instance_id = getattr(request.app.state, "instance_id", "")
    if instance_id:
        await run_store.set_owner_instance(run_id, instance_id)
    await run_store.write_checkpoint(
        run_id,
        {
            "run_id": run_id,
            "user_id": user_id,
            "session_id": body.session_id,
            "flow_id": body.flow_id or "",
            "message": body.message,
            "client_request_id": client_request_id,
        },
    )
    _track_run_task(request.app, run_store, run_id, loop.run(run_input))


async def _active_task_backed_run_id(run_store: RedisRunStore, session_id: str) -> str | None:
    run_id = await run_store.get_active_run_id(session_id)
    if not run_id:
        return None
    meta = await run_store.get_run_meta(run_id)
    return run_id if meta.get("status") in TASK_BACKED_RUN_STATUSES else None


async def _require_owned_run(
    run_store: RedisRunStore,
    run_id: str,
    user_id: str,
) -> dict[str, str]:
    meta = await run_store.get_run_meta(run_id)
    if not meta:
        raise HTTPException(status_code=404, detail={"code": "RUN_NOT_FOUND"})
    if meta.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail={"code": "RUN_FORBIDDEN"})
    return meta


def _authenticate_agent_user(
    *,
    authorization: str | None,
    requested_user_id: str | None,
    settings: Settings,
) -> AuthenticatedAgentUser:
    bearer = _bearer_token(authorization)
    if bearer is None:
        return _authenticate_public_chat(settings, requested_user_id)

    public_key = settings.clerk_pem_public_key.strip()
    if not public_key:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"})
    try:
        payload = jwt.decode(bearer, public_key, algorithms=["RS256"])
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"}) from exc
    user_id = payload.get("sub") if isinstance(payload, dict) else None
    if not isinstance(user_id, str) or not user_id.strip():
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"})
    return AuthenticatedAgentUser(user_id=user_id.strip(), token=bearer)


def _authenticate_public_chat(
    settings: Settings,
    requested_user_id: str | None,
) -> AuthenticatedAgentUser:
    configured_user_id = settings.public_chat_user_id.strip()
    if not configured_user_id:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"})
    requested = requested_user_id.strip() if isinstance(requested_user_id, str) else ""
    if requested and requested != configured_user_id:
        raise HTTPException(status_code=403, detail={"code": "RUN_FORBIDDEN"})
    return AuthenticatedAgentUser(user_id=configured_user_id, token="")


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    return token or None


def _session_manager(request: Request, settings: Settings) -> SessionManager:
    return SessionManager.from_database(_database(request, settings), _redis(request))


def _run_store(request: Request) -> RedisRunStore:
    return RedisRunStore(_redis(request))


def _run_store_from_app(app: Any) -> RedisRunStore:
    return RedisRunStore(app.state.dependencies.redis)


def _session_manager_from_app(app: Any, settings: Settings) -> SessionManager:
    database = app.state.dependencies.mongo[settings.mongodb_database]
    return SessionManager.from_database(database, app.state.dependencies.redis)


def _database(request: Request, settings: Settings) -> Any:
    return request.app.state.dependencies.mongo[settings.mongodb_database]


def _redis(request: Request) -> Any:
    return request.app.state.dependencies.redis


def _format_sse_event(
    *,
    event_name: str,
    data: dict[str, Any],
    event_id: str | None = None,
) -> str:
    lines: list[str] = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_name}")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for line in payload.splitlines() or [""]:
        lines.append(f"data: {line}")
    return "\n".join(lines) + "\n\n"


def _format_sse_comment(comment: str) -> str:
    return "\n".join(f": {line}" for line in str(comment).splitlines() or [""]) + "\n\n"


def _json(data: dict[str, Any], status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=data)


router = create_agent_router()
