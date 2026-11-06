"""Agent run loop.

The loop owns one task-backed Agent run: it loads durable session facts, appends
the current user turn early, calls the LLM/tool stack, writes SSE events through
RedisRunStore, and persists the resulting session projection.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from novelcomic_agent.agents.main.profile import (
    DEFAULT_AGENT_FACTORY,
    AgentContext,
    AgentFactory,
    AgentTool,
    RuntimeAgentProfile,
)
from novelcomic_agent.core import events
from novelcomic_agent.core.events import AgentEvent
from novelcomic_agent.core.tools.base import Tool
from novelcomic_agent.services.agent_redis_run_store import RedisRunStore
from novelcomic_agent.session.manager import Session, SessionManager

BASE_MAX_ITERATIONS = 40
MAX_HISTORY_MESSAGES = 80
MAX_TOOL_RESULT_CHARS = 16_000
MAX_OUTPUT_PREVIEW_CHARS = 1_000


@dataclass(slots=True)
class AgentRunInput:
    """Input captured by ``POST /v1/agent/runs`` and passed to the background task."""

    user_id: str
    session_id: str
    run_id: str
    flow_id: str
    message: str
    client_request_id: str
    workflow_snapshot: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    agent_model: str | None = None
    profile_name: str = "main"
    channel: str = "api"


@dataclass(slots=True)
class ToolTrace:
    session_id: str
    turn: int
    tool_call_id: str
    tool_name: str
    input: dict[str, Any]
    output: str = ""
    output_size_bytes: int = 0
    status: str = "success"
    error: str | None = None
    duration_ms: int = 0

    def to_doc(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "turn": self.turn,
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
            "input": self.input,
            "output": self.output,
            "output_size_bytes": self.output_size_bytes,
            "status": self.status,
            "error": self.error,
            "duration_ms": self.duration_ms,
        }


@dataclass(slots=True)
class LoopResult:
    final_content: str
    status: str = "complete"
    tool_traces: list[ToolTrace] = field(default_factory=list)


class AgentCancelledError(Exception):
    """Raised when a Redis cancel flag is observed during a run."""


class HitlInterrupt(Exception):
    """Raised when a tool asks the loop to pause for human input."""

    def __init__(
        self,
        *,
        tool_call_id: str,
        hitl_type: str,
        data: dict[str, Any],
        tool_name: str | None = None,
    ) -> None:
        super().__init__("agent run interrupted for human input")
        self.tool_call_id = tool_call_id
        self.hitl_type = hitl_type
        self.data = data
        self.tool_name = tool_name


class AgentLoop:
    """Run an Agent turn and publish resumable SSE events."""

    _session_locks: dict[str, asyncio.Lock] = {}
    _session_locks_guard = asyncio.Lock()
    _global_gate = asyncio.Semaphore(
        int(
            os.getenv("CREATO_MAX_CONCURRENT_REQUESTS")
            or os.getenv("AGENT_MAX_CONCURRENT_REQUESTS")
            or "8"
        )
    )

    def __init__(
        self,
        *,
        session_manager: SessionManager,
        run_store: RedisRunStore,
        llm_client: Any,
        agent_factory: AgentFactory = DEFAULT_AGENT_FACTORY,
        max_iterations: int = BASE_MAX_ITERATIONS,
        memory_retriever: Callable[[Session, AgentRunInput], Awaitable[list[dict[str, Any]]]]
        | None = None,
        workflow_dao: Any | None = None,
        redis_client: Any | None = None,
        templates_col: Any | None = None,
        share_flow_col: Any | None = None,
    ) -> None:
        self.session_manager = session_manager
        self.run_store = run_store
        self.llm_client = llm_client
        self.agent_factory = agent_factory
        self.max_iterations = max_iterations
        self.memory_retriever = memory_retriever
        self.workflow_dao = workflow_dao
        self.redis_client = redis_client
        self.templates_col = templates_col
        self.share_flow_col = share_flow_col
        self._mcp_servers: list[Any] = []
        self._mcp_stack: list[Any] = []
        self._mcp_connected = False
        self._mcp_connecting = False

    async def run(self, request: AgentRunInput) -> LoopResult:
        """Execute one run under per-session and process-wide concurrency guards."""

        session_lock = await self._get_session_lock(request.session_id)
        try:
            async with session_lock:
                async with self._global_gate:
                    return await self._process_message(request)
        finally:
            await self.close_mcp()

    async def _process_message(self, request: AgentRunInput) -> LoopResult:
        turn_id = ""
        try:
            await self._connect_mcp()
            await self._emit(
                events.agent_started(request.session_id, request.run_id),
                request.run_id,
            )
            await self.run_store.mark_status(request.run_id, "running")

            session = await self.session_manager.get_or_create(
                request.session_id,
                user_id=request.user_id,
                workflow_id=request.flow_id,
                channel=request.channel,
            )
            turn = session.turn_count + 1
            turn_id = self._turn_id(turn)

            await self._check_cancelled(request)
            self._resolve_pending_hitl(session, request, turn)
            uploaded_files = session.collect_uploaded_files()

            user_message = self._build_user_message(request, turn, uploaded_files)
            session.append_message(user_message)
            session.status = "running"
            await self.session_manager.save(session)

            revision = session.revision
            seq = session.last_seq + 1
            assistant_message_id = f"{session.session_id}:{turn_id}:assistant"
            await self._emit(
                events.chat_message_created(
                    session_id=session.session_id,
                    turn_id=turn_id,
                    run_id=request.run_id,
                    revision=revision,
                    seq=seq,
                    message={
                        "message_id": assistant_message_id,
                        "role": "assistant",
                        "status": "streaming",
                        "parts": [],
                    },
                ),
                request.run_id,
            )

            profile_context = self._build_profile_context(request, session)
            runtime_profile = self.agent_factory.build(profile_context, request.profile_name)
            loop_result = await self._run_agent_loop(
                session=session,
                request=request,
                runtime_profile=runtime_profile,
                turn=turn,
                turn_id=turn_id,
                assistant_message_id=assistant_message_id,
            )

            if loop_result.status == "waiting_hitl":
                session.status = "waiting_hitl"
            else:
                session.append_message(
                    {
                        "role": "assistant",
                        "content": loop_result.final_content,
                        "turn": turn,
                        "metadata": {"run_id": request.run_id},
                        "status": "complete",
                    }
                )
                session.status = "idle"

            await self.session_manager.save(
                session,
                tool_traces=[trace.to_doc() for trace in loop_result.tool_traces],
            )
            revision = session.revision
            seq = session.last_seq

            await self._emit(
                events.chat_message_completed(
                    session_id=session.session_id,
                    turn_id=turn_id,
                    run_id=request.run_id,
                    revision=revision,
                    seq=seq,
                    message_id=assistant_message_id,
                    status=loop_result.status,
                ),
                request.run_id,
            )

            if loop_result.status == "waiting_hitl":
                await self._emit(
                    events.session_state_updated(
                        session_id=session.session_id,
                        turn_id=turn_id,
                        run_id=request.run_id,
                        revision=revision,
                        seq=seq,
                        state={
                            "status": "waiting_hitl",
                            "current_hitl": session.current_hitl,
                            "pipeline_state": session.pipeline_state,
                        },
                    ),
                    request.run_id,
                )
                return loop_result

            await self._emit(events.agent_completed(loop_result.final_content), request.run_id)
            await self._emit(
                events.run_completed(
                    session_id=session.session_id,
                    turn_id=turn_id,
                    run_id=request.run_id,
                    revision=revision,
                    seq=seq + 1,
                ),
                request.run_id,
            )
            return loop_result
        except AgentCancelledError:
            await self._emit(events.agent_stopped("cancelled"), request.run_id)
            await self._emit(
                events.run_cancelled(
                    session_id=request.session_id,
                    turn_id=turn_id or "turn-unknown",
                    run_id=request.run_id,
                    revision=0,
                    seq=0,
                    reason="cancelled",
                ),
                request.run_id,
            )
            return LoopResult(final_content="", status="cancelled")
        except asyncio.CancelledError:
            await self._emit(events.agent_stopped("cancelled"), request.run_id)
            await self._emit(
                events.run_cancelled(
                    session_id=request.session_id,
                    turn_id=turn_id or "turn-unknown",
                    run_id=request.run_id,
                    revision=0,
                    seq=0,
                    reason="cancelled",
                ),
                request.run_id,
            )
            raise
        except Exception as exc:
            await self._emit(events.agent_failed(str(exc), code=type(exc).__name__), request.run_id)
            await self._emit(
                events.run_failed(
                    session_id=request.session_id,
                    turn_id=turn_id or "turn-unknown",
                    run_id=request.run_id,
                    revision=0,
                    seq=0,
                    error=str(exc),
                    code=type(exc).__name__,
                ),
                request.run_id,
            )
            raise

    async def _run_agent_loop(
        self,
        *,
        session: Session,
        request: AgentRunInput,
        runtime_profile: RuntimeAgentProfile,
        turn: int,
        turn_id: str,
        assistant_message_id: str,
    ) -> LoopResult:
        max_iterations = runtime_profile.max_iterations or self.max_iterations
        messages = await self._build_messages(session, request, runtime_profile)
        tool_traces: list[ToolTrace] = []
        final_content = ""
        revision = session.revision
        seq = session.last_seq + 1

        for iteration in range(max_iterations):
            await self._check_cancelled(request)
            response = await self._call_llm(
                messages=messages,
                runtime_profile=runtime_profile,
                model=request.agent_model or runtime_profile.model,
            )
            content = response.get("content", "")
            thinking = response.get("thinking", "")
            tool_calls = response.get("tool_calls", [])

            if thinking:
                await self._emit(events.thinking_delta(thinking), request.run_id)
            if content:
                final_content += content
                await self._emit(
                    events.chat_message_delta(
                        session_id=session.session_id,
                        turn_id=turn_id,
                        run_id=request.run_id,
                        revision=revision,
                        seq=seq,
                        message_id=assistant_message_id,
                        part_id="text:main",
                        text=content,
                    ),
                    request.run_id,
                )

            await self._emit(
                events.llm_response_completed(
                    iteration=iteration + 1,
                    content=content,
                    tool_names=[
                        str(call.get("name") or call.get("tool_name") or "")
                        for call in tool_calls
                        if isinstance(call, dict)
                    ],
                    finish_reason=str(response.get("finish_reason") or "stop"),
                ),
                request.run_id,
            )

            if not tool_calls:
                return LoopResult(final_content=final_content, tool_traces=tool_traces)

            messages.append(
                {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tool_calls,
                }
            )
            for raw_call in tool_calls:
                await self._check_cancelled(request)
                tool_call = self._normalize_tool_call(raw_call)
                try:
                    result, trace = await self._execute_tool_call(
                        session=session,
                        request=request,
                        runtime_profile=runtime_profile,
                        turn=turn,
                        tool_call=tool_call,
                    )
                except HitlInterrupt as interrupt:
                    interrupt.tool_call_id = tool_call["id"]
                    interrupt.tool_name = interrupt.tool_name or tool_call["name"]
                    session.append_message(
                        {
                            "role": "assistant",
                            "content": content,
                            "turn": turn,
                            "tool_calls": [tool_call],
                        }
                    )
                    session.append_message(
                        {
                            "role": "tool",
                            "content": "等待用户操作",
                            "turn": turn,
                            "tool_call_id": interrupt.tool_call_id,
                            "name": tool_call["name"],
                            "tool_name": tool_call["name"],
                        }
                    )
                    self._persist_hitl_interrupt(session, turn, interrupt)
                    await self._emit(
                        events.tool_event(
                            "hitl.request",
                            {
                                "tool_call_id": interrupt.tool_call_id,
                                "tool_name": interrupt.tool_name,
                                "type": interrupt.hitl_type,
                                "data": interrupt.data,
                            },
                        ),
                        request.run_id,
                    )
                    await self._emit(
                        events.chat_part_upsert(
                            session_id=session.session_id,
                            turn_id=turn_id,
                            run_id=request.run_id,
                            revision=revision,
                            seq=seq,
                            message_id=assistant_message_id,
                            part={
                                "type": "hitl",
                                "part_id": f"hitl:{interrupt.tool_call_id}",
                                "hitl_id": interrupt.tool_call_id,
                                "hitl_type": interrupt.hitl_type,
                                "status": "pending",
                                "data": interrupt.data,
                            },
                        ),
                        request.run_id,
                    )
                    return LoopResult(
                        final_content="",
                        status="waiting_hitl",
                        tool_traces=tool_traces,
                    )

                tool_traces.append(trace)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call["id"],
                        "name": tool_call["name"],
                        "content": result,
                    }
                )

        raise RuntimeError(f"agent loop exceeded max_iterations={max_iterations}")

    async def _execute_tool_call(
        self,
        *,
        session: Session,
        request: AgentRunInput,
        runtime_profile: RuntimeAgentProfile,
        turn: int,
        tool_call: dict[str, Any],
    ) -> tuple[str, ToolTrace]:
        tool_name = tool_call["name"]
        tool_call_id = tool_call["id"]
        arguments = tool_call["arguments"]
        tool = runtime_profile.tools.get(tool_name)
        if tool is None:
            raise RuntimeError(f"unknown tool requested by model: {tool_name}")

        session.append_message(
            {
                "role": "tool_call",
                "content": None,
                "turn": turn,
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "tool_call": tool_call,
            }
        )
        await self._emit(events.tool_started(tool_name, tool_call_id, arguments), request.run_id)

        started = time.perf_counter()
        try:
            if isinstance(tool, Tool):
                raw_result = await runtime_profile.tools.execute(tool_name, arguments)
            else:
                raw_result = await tool.execute(arguments, runtime_profile.context)
        except HitlInterrupt:
            raise
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            session.append_message(
                {
                    "role": "tool_result",
                    "content": "",
                    "turn": turn,
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "status": "error",
                    "error": str(exc),
                }
            )
            await self._emit(
                events.tool_failed(tool_call_id, str(exc), type(exc).__name__),
                request.run_id,
            )
            return "", ToolTrace(
                session_id=session.session_id,
                turn=turn,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                input=arguments,
                status="error",
                error=str(exc),
                duration_ms=duration_ms,
            )

        duration_ms = int((time.perf_counter() - started) * 1000)
        result = self._stringify_tool_result(raw_result)
        truncated = len(result) > MAX_TOOL_RESULT_CHARS
        if truncated:
            result = result[:MAX_TOOL_RESULT_CHARS]
        session.append_message(
            {
                "role": "tool_result",
                "content": result,
                "turn": turn,
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "status": "complete",
                "output_size_bytes": len(result.encode("utf-8")),
                "truncated": truncated,
            }
        )
        await self._emit(
            events.tool_completed(
                tool_call_id,
                duration_ms,
                output_preview=result[:MAX_OUTPUT_PREVIEW_CHARS],
            ),
            request.run_id,
        )
        return result, ToolTrace(
            session_id=session.session_id,
            turn=turn,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            input=arguments,
            output=result,
            output_size_bytes=len(result.encode("utf-8")),
            duration_ms=duration_ms,
        )

    async def _call_llm(
        self,
        *,
        messages: Sequence[dict[str, Any]],
        runtime_profile: RuntimeAgentProfile,
        model: str | None,
    ) -> dict[str, Any]:
        if self.llm_client is None:
            raise RuntimeError("llm_client is required")
        tools = (
            runtime_profile.tools.get_definitions()
            if hasattr(runtime_profile.tools, "get_definitions")
            else self._llm_tool_specs(runtime_profile.tools.values())
        )
        payload = {"messages": list(messages), "tools": tools, "model": model}

        for method_name in ("complete", "chat", "create"):
            method = getattr(self.llm_client, method_name, None)
            if callable(method):
                return self._normalize_llm_response(await _maybe_await(method(**payload)))
        if callable(self.llm_client):
            return self._normalize_llm_response(await _maybe_await(self.llm_client(**payload)))
        raise RuntimeError("llm_client does not expose complete/chat/create")

    async def _build_messages(
        self,
        session: Session,
        request: AgentRunInput,
        runtime_profile: RuntimeAgentProfile,
    ) -> list[dict[str, Any]]:
        history = self._microcompact_history(session.get_history(MAX_HISTORY_MESSAGES))
        history = self._trim_history(history)
        memory = await self._retrieve_memory(session, request)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": runtime_profile.system_prompt}
        ]
        if request.workflow_snapshot:
            messages.append(
                {
                    "role": "system",
                    "content": "Current workflow snapshot:\n"
                    + json.dumps(request.workflow_snapshot, ensure_ascii=False),
                }
            )
        if memory:
            messages.append(
                {
                    "role": "system",
                    "content": "Relevant memory:\n" + json.dumps(memory, ensure_ascii=False),
                }
            )
        messages.extend(history)
        return messages

    async def _retrieve_memory(
        self,
        session: Session,
        request: AgentRunInput,
    ) -> list[dict[str, Any]]:
        if self.memory_retriever is None:
            return []
        return await self.memory_retriever(session, request)

    def _resolve_pending_hitl(self, session: Session, request: AgentRunInput, turn: int) -> None:
        pending = session.metadata.get("pending_hitl")
        if not isinstance(pending, dict):
            return
        tool_call_id = str(pending.get("tool_call_id") or "")
        if not tool_call_id:
            session.metadata.pop("pending_hitl", None)
            return
        session.replace_last_tool_result(tool_call_id, request.message)
        session.append_message(
            {
                "role": "tool_event",
                "content": request.message,
                "turn": turn,
                "tool_call_id": tool_call_id,
                "tool_name": pending.get("tool_name"),
                "event": "hitl.resolved",
                "event_data": self._hitl_resolved_payload(request),
            }
        )
        session.metadata.pop("pending_hitl", None)

    def _persist_hitl_interrupt(
        self,
        session: Session,
        turn: int,
        interrupt: HitlInterrupt,
    ) -> None:
        session.metadata["pending_hitl"] = {
            "type": interrupt.hitl_type,
            "tool_call_id": interrupt.tool_call_id,
            "tool_name": interrupt.tool_name,
            "data": interrupt.data,
        }
        session.append_message(
            {
                "role": "tool_event",
                "content": interrupt.data.get("message", ""),
                "turn": turn,
                "tool_call_id": interrupt.tool_call_id,
                "tool_name": interrupt.tool_name,
                "event": "hitl.request",
                "event_data": {
                    "type": interrupt.hitl_type,
                    "tool_call_id": interrupt.tool_call_id,
                    "tool_name": interrupt.tool_name,
                    "data": interrupt.data,
                    **interrupt.data,
                },
            }
        )

    def _build_profile_context(self, request: AgentRunInput, session: Session) -> AgentContext:
        metadata = dict(request.metadata)
        metadata.setdefault("session_revision", session.revision)
        redis_client = self.redis_client or getattr(self.run_store, "_redis", None)
        return AgentContext(
            user_id=request.user_id,
            session_id=request.session_id,
            run_id=request.run_id,
            flow_id=request.flow_id,
            workflow_snapshot=request.workflow_snapshot,
            metadata=metadata,
            llm_client=self.llm_client,
            workflow_dao=self.workflow_dao,
            redis_client=redis_client,
            templates_col=self.templates_col,
            share_flow_col=self.share_flow_col,
        )

    @staticmethod
    def _build_user_message(
        request: AgentRunInput,
        turn: int,
        uploaded_files: list[dict[str, Any]],
    ) -> dict[str, Any]:
        metadata = dict(request.metadata)
        if uploaded_files:
            metadata.setdefault("historical_files", uploaded_files)
        if request.workflow_snapshot:
            metadata["workflow_snapshot"] = request.workflow_snapshot
        metadata["client_request_id"] = request.client_request_id
        metadata["run_id"] = request.run_id
        metadata["flow_id"] = request.flow_id
        return {
            "role": "user",
            "content": request.message,
            "turn": turn,
            "metadata": metadata,
        }

    @staticmethod
    def _hitl_resolved_payload(request: AgentRunInput) -> dict[str, Any]:
        payload: dict[str, Any] = {"reply_text": request.message}
        hitl = request.metadata.get("hitl") if isinstance(request.metadata, dict) else None
        if isinstance(hitl, dict):
            payload.update(hitl)
        return payload

    @staticmethod
    def _normalize_tool_call(raw_call: Any) -> dict[str, Any]:
        if not isinstance(raw_call, Mapping):
            raise RuntimeError(f"invalid tool call: {raw_call!r}")
        name = raw_call.get("name") or raw_call.get("tool_name")
        if not isinstance(name, str) or not name:
            function = raw_call.get("function")
            if isinstance(function, Mapping):
                name = function.get("name")
        if not isinstance(name, str) or not name:
            raise RuntimeError(f"tool call missing name: {raw_call!r}")
        arguments = raw_call.get("arguments")
        if arguments is None and isinstance(raw_call.get("function"), Mapping):
            arguments = raw_call["function"].get("arguments")
        if isinstance(arguments, str):
            arguments = json.loads(arguments or "{}")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise RuntimeError(f"tool call arguments must be an object: {raw_call!r}")
        tool_call_id = raw_call.get("id") or raw_call.get("tool_call_id")
        return {
            "id": str(tool_call_id or f"tool_{uuid4().hex[:12]}"),
            "name": name,
            "arguments": arguments,
        }

    @staticmethod
    def _normalize_llm_response(response: Any) -> dict[str, Any]:
        if isinstance(response, str):
            return {"content": response, "tool_calls": [], "finish_reason": "stop"}
        if isinstance(response, Mapping):
            thinking = response.get("thinking") or response.get("reasoning_content") or ""
            return {
                "content": str(response.get("content") or response.get("text") or ""),
                "thinking": str(thinking),
                "tool_calls": list(response.get("tool_calls") or []),
                "finish_reason": response.get("finish_reason") or "stop",
            }
        content = getattr(response, "content", None) or getattr(response, "text", None) or ""
        tool_calls = getattr(response, "tool_calls", None) or []
        thinking = (
            getattr(response, "thinking", None)
            or getattr(response, "reasoning_content", None)
            or ""
        )
        return {
            "content": str(content),
            "thinking": str(thinking),
            "tool_calls": list(tool_calls),
            "finish_reason": getattr(response, "finish_reason", "stop"),
        }

    @staticmethod
    def _llm_tool_specs(tools: Sequence[AgentTool]) -> list[dict[str, Any]]:
        specs: list[dict[str, Any]] = []
        for tool in tools:
            specs.append(
                {
                    "name": tool.name,
                    "description": getattr(tool, "description", ""),
                    "input_schema": getattr(tool, "input_schema", {"type": "object"}),
                }
            )
        return specs

    @staticmethod
    def _microcompact_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        compacted: list[dict[str, Any]] = []
        previous_role: str | None = None
        buffer: list[str] = []
        for message in messages:
            role = str(message.get("role") or "")
            content = message.get("content")
            if role == previous_role == "assistant" and isinstance(content, str):
                buffer.append(content)
                continue
            if buffer and compacted:
                compacted[-1]["content"] = "\n".join(buffer)
                buffer = []
            compacted.append(dict(message))
            previous_role = role
            if role == "assistant" and isinstance(content, str):
                buffer = [content]
        if buffer and compacted:
            compacted[-1]["content"] = "\n".join(buffer)
        return compacted

    @staticmethod
    def _trim_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return messages[-MAX_HISTORY_MESSAGES:]

    @staticmethod
    def _stringify_tool_result(value: Any) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, default=str)

    async def _check_cancelled(self, request: AgentRunInput) -> None:
        if await self.run_store.is_run_cancel_requested(request.run_id):
            raise AgentCancelledError()
        if await self.run_store.is_request_cancelled(
            user_id=request.user_id,
            session_id=request.session_id,
            client_request_id=request.client_request_id,
        ):
            raise AgentCancelledError()

    async def _connect_mcp(self) -> None:
        return  # dynamic registration stays disabled

    async def close_mcp(self) -> None:
        self._mcp_connected = False
        self._mcp_connecting = False
        while self._mcp_stack:
            session = self._mcp_stack.pop()
            close = getattr(session, "aclose", None) or getattr(session, "close", None)
            if not callable(close):
                continue
            result = close()
            if inspect.isawaitable(result):
                await result

    async def _emit(self, event: AgentEvent, run_id: str) -> str:
        return await self.run_store.append_event(run_id, event.event, event.data)

    @classmethod
    async def _get_session_lock(cls, session_id: str) -> asyncio.Lock:
        async with cls._session_locks_guard:
            lock = cls._session_locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                cls._session_locks[session_id] = lock
            return lock

    @staticmethod
    def _turn_id(turn: int) -> str:
        return f"turn-{turn}"


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value
