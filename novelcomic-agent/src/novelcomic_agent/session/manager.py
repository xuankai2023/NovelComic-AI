"""MongoDB and Redis backed agent session management."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from novelcomic_agent.schemas.session import (
    AgentRuntimeEventDoc,
    AgentSessionDoc,
    AgentToolTraceDoc,
    ChatProjectionMessageDoc,
    RawMessageDoc,
)

logger = logging.getLogger(__name__)

REDIS_META_PREFIX = "agent:session:meta:"
REDIS_CTX_PREFIX = "agent:session:ctx:"
REDIS_TTL_SECONDS = 60 * 60 * 24
LLM_EXCLUDED_ROLES = {"workflow_event", "tool_call", "tool_event", "tool_result"}
CHAT_PROJECTION_ROLES = {"user", "assistant", "tool_call", "tool_event", "tool_result"}


def _utc_now() -> datetime:
    return datetime.utcnow()


def _iso_now() -> str:
    return _utc_now().isoformat()


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _coerce_datetime(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return fallback
    return fallback


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(part for part in parts if part)


def _parse_hitl_message_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped.startswith("{") or not stripped.endswith("}"):
        return None
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _normalize_hitl_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    message = value
    for _ in range(3):
        parsed = _parse_hitl_message_object(message)
        next_message = parsed.get("message") if isinstance(parsed, dict) else None
        if not isinstance(next_message, str) or next_message == message:
            break
        message = next_message
    return message


def _normalize_hitl_data(data: Any) -> dict[str, Any]:
    raw = data if isinstance(data, dict) else {}
    nested_message = _parse_hitl_message_object(raw.get("message"))
    merged = {**raw, **nested_message} if nested_message else raw
    normalized: dict[str, Any] = {
        "message": _normalize_hitl_text(merged.get("message")),
        "options": merged.get("options") if isinstance(merged.get("options"), list) else [],
    }
    if isinstance(merged.get("title"), str):
        normalized["title"] = _normalize_hitl_text(merged["title"])
    if isinstance(merged.get("questions"), list):
        normalized["questions"] = merged["questions"]
    if isinstance(merged.get("answers"), list):
        normalized["answers"] = merged["answers"]
    for key in (
        "selected_option_id",
        "submitted_reply_text",
        "reply_text",
        "submitted_reply_label",
    ):
        if isinstance(merged.get(key), str):
            normalized[key] = merged[key]
    return normalized


def _normalize_current_hitl(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    hitl_type = value.get("type")
    if hitl_type not in {"select", "ask"}:
        return None
    raw_data = value.get("data")
    data = _normalize_hitl_data(
        raw_data
        if isinstance(raw_data, dict)
        else {"message": raw_data}
        if isinstance(raw_data, str)
        else {}
    )
    if hitl_type == "select" and not data.get("options"):
        return None
    if hitl_type == "ask" and not data.get("questions"):
        data["questions"] = [
            {
                "id": "q-1",
                "title": data.get("message") or "请补充信息",
                "options": [],
                "allow_attachments": False,
            }
        ]
    return {
        "type": hitl_type,
        "tool_call_id": value.get("tool_call_id"),
        "data": data,
    }


def _strip_mongo_fields(doc: dict[str, Any]) -> dict[str, Any]:
    clean = dict(doc)
    clean.pop("_id", None)
    clean.pop("session_id", None)
    clean.pop("seq", None)
    return clean


@dataclass
class Session:
    """Append-only conversation state used by the agent loop."""

    session_id: str
    user_id: str = ""
    workflow_id: str | None = None
    channel: str = "api"
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=_utc_now)
    updated_at: datetime = field(default_factory=_utc_now)
    summary: str | None = None
    message_count: int = 0
    turn_count: int = 0
    status: str = "idle"
    revision: int = 0
    last_seq: int = 0
    last_message_preview: str | None = None
    current_hitl: dict[str, Any] | None = None
    pipeline_state: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    _persisted_count: int = field(default=0, repr=False)

    def append_message(self, message: dict[str, Any]) -> dict[str, Any]:
        """Validate and append one raw message to the in-memory session."""

        raw = dict(message)
        raw.setdefault("created_at", _iso_now())
        validated = RawMessageDoc.model_validate(raw).model_dump(exclude_none=True)
        self.messages.append(validated)
        if validated["role"] in {"user", "assistant"}:
            self.message_count += 1
            preview = _message_text(validated.get("content")).strip()
            if preview:
                self.last_message_preview = preview[:240]
        if validated["role"] == "user" and isinstance(validated.get("turn"), int):
            self.turn_count = max(self.turn_count, int(validated["turn"]))
        self.updated_at = _utc_now()
        return validated

    def get_history(self, max_messages: int = 500) -> list[dict[str, Any]]:
        """Return provider-facing history, excluding display/runtime-only records."""

        messages = [
            message
            for message in self.messages
            if not message.get("is_ephemeral") and message.get("role") not in LLM_EXCLUDED_ROLES
        ]
        if max_messages > 0:
            messages = messages[-max_messages:]
        return [dict(message) for message in messages]

    def collect_uploaded_files(self) -> list[dict[str, Any]]:
        """Collect user-uploaded file references across all turns, oldest first."""

        seen_urls: set[str] = set()
        files: list[dict[str, Any]] = []
        for message in self.messages:
            if message.get("role") != "user":
                continue
            metadata = message.get("metadata")
            if not isinstance(metadata, dict) or not isinstance(metadata.get("files"), list):
                continue
            turn = message.get("turn") if isinstance(message.get("turn"), int) else 0
            for item in metadata["files"]:
                if not isinstance(item, dict):
                    continue
                url = item.get("url")
                if not isinstance(url, str) or not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                entry = {"turn": turn, "type": item.get("type") or "file", "url": url}
                for key in ("filename", "name", "tag", "mime_type"):
                    if isinstance(item.get(key), str) and item[key]:
                        entry[key] = item[key]
                files.append(entry)
        return files

    def replace_last_tool_result(self, tool_call_id: str, new_content: str) -> bool:
        """Replace the most recent matching tool result for HITL resume."""

        for message in reversed(self.messages):
            if message.get("role") == "tool" and message.get("tool_call_id") == tool_call_id:
                message["content"] = new_content
                return True
        return False


class SessionManager:
    """Owns long-lived session facts. SSE/run state is handled elsewhere."""

    def __init__(
        self,
        sessions_col: Any,
        messages_col: Any,
        tool_traces_col: Any,
        redis_client: Any | None,
        chat_messages_col: Any | None = None,
        events_col: Any | None = None,
    ) -> None:
        self._sessions_col = sessions_col
        self._messages_col = messages_col
        self._traces_col = tool_traces_col
        self._redis = redis_client
        self._chat_messages_col = chat_messages_col
        self._events_col = events_col

    @classmethod
    def from_database(cls, database: Any, redis_client: Any | None) -> SessionManager:
        """Build a manager from a Mongo database object and optional Redis client."""

        return cls(
            sessions_col=database["agent_sessions"],
            messages_col=database["agent_messages"],
            tool_traces_col=database["agent_tool_traces"],
            redis_client=redis_client,
            chat_messages_col=database["agent_chat_messages"],
            events_col=database["agent_events"],
        )

    async def get_or_create(
        self,
        session_id: str,
        user_id: str = "",
        workflow_id: str | None = None,
        channel: str = "api",
    ) -> Session:
        """Load a session from Redis, then Mongo, or create a new one."""

        session = await self._load_from_redis(session_id)
        if session is not None:
            return session

        session = await self._load_from_mongo(session_id)
        if session is not None:
            await self._write_redis(session)
            return session

        return Session(
            session_id=session_id,
            user_id=user_id,
            workflow_id=workflow_id,
            channel=channel,
        )

    async def save(
        self,
        session: Session,
        tool_traces: list[dict[str, Any]] | None = None,
    ) -> None:
        """Append raw messages, upsert session metadata, rebuild projection, and cache."""

        now = _utc_now()
        session.updated_at = now
        mongo_next_seq = await self._next_message_seq(session.session_id)
        if mongo_next_seq < session._persisted_count:
            session._persisted_count = mongo_next_seq

        new_messages = session.messages[session._persisted_count :]
        base_seq = max(session._persisted_count, mongo_next_seq)
        docs = [
            {
                "session_id": session.session_id,
                "seq": base_seq + index,
                **RawMessageDoc.model_validate(message).model_dump(exclude_none=True),
            }
            for index, message in enumerate(new_messages)
        ]

        existing_session = await self._sessions_col.find_one(
            {"_id": session.session_id},
            projection={"revision": 1, "last_seq": 1},
        )
        if existing_session:
            session.revision = max(session.revision, int(existing_session.get("revision", 0)))
            session.last_seq = max(session.last_seq, int(existing_session.get("last_seq", 0)))

        if docs:
            await self._messages_col.insert_many(docs, ordered=True)
            session._persisted_count = len(session.messages)
            session.last_seq = max(session.last_seq, int(docs[-1]["seq"]))
            session.revision += 1
            await self._write_runtime_events(session, docs)
            await self._rebuild_chat_projection_for_docs(session, docs)

        session.current_hitl = _normalize_current_hitl(session.metadata.get("pending_hitl"))
        session.pipeline_state = self._pipeline_state_from_metadata(session.metadata)
        session.status = "waiting_hitl" if session.current_hitl else "idle"

        await self._upsert_session_doc(session)
        await self._insert_tool_traces(tool_traces or [])
        await self._write_redis(session)

    async def append_runtime_message(
        self,
        session_id: str,
        message: dict[str, Any],
        *,
        rebuild_projection: bool = True,
    ) -> dict[str, Any]:
        """Append one runtime/display message outside the main agent turn save."""

        raw_message = dict(message)
        raw_message.setdefault("created_at", _iso_now())
        seq = await self._next_message_seq(session_id)
        doc = {
            "session_id": session_id,
            "seq": seq,
            **RawMessageDoc.model_validate(raw_message).model_dump(exclude_none=True),
        }
        await self._messages_col.insert_many([doc], ordered=True)

        session = await self.get_or_create(session_id)
        session.revision += 1
        session.last_seq = max(session.last_seq, seq)
        await self._write_runtime_events(session, [doc])
        if rebuild_projection:
            await self._rebuild_chat_projection_for_docs(session, [doc])

        await self._sessions_col.update_one(
            {"_id": session_id},
            {
                "$set": {
                    "revision": session.revision,
                    "last_seq": session.last_seq,
                    "updated_at": _utc_now(),
                }
            },
            upsert=False,
        )
        await self._redis_delete(f"{REDIS_CTX_PREFIX}{session_id}")
        await self._redis_delete(f"{REDIS_META_PREFIX}{session_id}")
        return doc

    async def get_messages_page(
        self,
        session_id: str,
        limit: int = 20,
        before_seq: int | None = None,
    ) -> dict[str, Any]:
        """Return frontend chat projection messages in chronological order."""

        query: dict[str, Any] = {"session_id": session_id}
        if before_seq is not None:
            query["seq_start"] = {"$lt": before_seq}
        cursor = (
            self._chat_messages_col.find(query)
            .sort([("seq_start", -1), ("created_at", -1), ("message_id", -1)])
            .limit(limit + 1)
        )
        docs = await cursor.to_list(length=limit + 1)
        has_more = len(docs) > limit
        docs = docs[:limit]
        docs.sort(key=lambda doc: (doc.get("seq_start", 0), doc.get("message_id", "")))

        messages: list[dict[str, Any]] = []
        for doc in docs:
            doc.pop("_id", None)
            message = ChatProjectionMessageDoc.model_validate(doc).model_dump(exclude_none=True)
            self._normalize_projection_hitl_parts(message)
            messages.append(message)

        session_doc = await self._sessions_col.find_one({"_id": session_id})
        session_state = {
            "revision": int((session_doc or {}).get("revision", 0)),
            "status": (session_doc or {}).get("status", "idle"),
            "current_hitl": _normalize_current_hitl((session_doc or {}).get("current_hitl")),
            "pipeline_state": (session_doc or {}).get("pipeline_state"),
        }
        next_cursor = messages[0]["seq_start"] if has_more and messages else None
        return {
            "messages": messages,
            "session_state": session_state,
            "next_cursor": next_cursor,
            "has_more": has_more,
        }

    async def collect_uploaded_files(self, session_id: str) -> list[dict[str, Any]]:
        """Load a session and return every uploaded file reference in its history."""

        session = await self.get_or_create(session_id)
        return session.collect_uploaded_files()

    async def _next_message_seq(self, session_id: str) -> int:
        latest = await self._messages_col.find_one(
            {"session_id": session_id},
            sort=[("seq", -1)],
            projection={"seq": 1},
        )
        return int(latest["seq"]) + 1 if latest and "seq" in latest else 0

    async def _upsert_session_doc(self, session: Session) -> None:
        meta = AgentSessionDoc(
            session_id=session.session_id,
            user_id=session.user_id,
            workflow_id=session.workflow_id,
            channel=session.channel,
            summary=session.summary,
            message_count=session.message_count,
            turn_count=session.turn_count,
            status=session.status,
            revision=session.revision,
            last_seq=session.last_seq,
            last_message_preview=session.last_message_preview,
            current_hitl=session.current_hitl,
            pipeline_state=session.pipeline_state,
            created_at=session.created_at,
            updated_at=session.updated_at,
            metadata=session.metadata,
        )
        set_fields = meta.model_dump(exclude_none=True)
        set_fields.pop("created_at", None)
        set_fields["current_hitl"] = session.current_hitl
        set_fields["pipeline_state"] = session.pipeline_state
        await self._sessions_col.update_one(
            {"_id": session.session_id},
            {
                "$set": set_fields,
                "$setOnInsert": {"created_at": session.created_at},
            },
            upsert=True,
        )

    async def _insert_tool_traces(self, tool_traces: list[dict[str, Any]]) -> None:
        if not tool_traces:
            return
        docs = [
            AgentToolTraceDoc.model_validate(trace).model_dump(exclude_none=True)
            for trace in tool_traces
        ]
        await self._traces_col.insert_many(docs, ordered=False)

    async def _write_runtime_events(self, session: Session, docs: list[dict[str, Any]]) -> None:
        if self._events_col is None:
            return
        event_docs: list[dict[str, Any]] = []
        for doc in docs:
            role = str(doc.get("role") or "")
            if role not in {"workflow_event", "tool_event", "tool_call", "tool_result"}:
                continue
            seq = int(doc.get("seq", 0))
            event_type = str(doc.get("event") or role)
            event_doc = AgentRuntimeEventDoc(
                event_id=f"{session.session_id}:{seq}",
                session_id=session.session_id,
                turn_id=self._turn_id(doc.get("turn")),
                seq=seq,
                type=event_type,
                payload=doc.get("event_data") if isinstance(doc.get("event_data"), dict) else {},
                created_at=doc.get("created_at"),
            ).model_dump(exclude_none=True)
            event_docs.append(event_doc)
        if event_docs:
            await self._events_col.insert_many(event_docs, ordered=True)

    async def _rebuild_chat_projection_for_docs(
        self,
        session: Session,
        docs: list[dict[str, Any]],
    ) -> None:
        if self._chat_messages_col is None or not docs:
            return
        turns = sorted({doc.get("turn") for doc in docs if isinstance(doc.get("turn"), int)})
        if not turns:
            return

        cursor = self._messages_col.find(
            {
                "session_id": session.session_id,
                "turn": {"$in": turns},
                "role": {"$in": list(CHAT_PROJECTION_ROLES)},
            }
        ).sort([("turn", 1), ("seq", 1)])
        raw_by_turn: dict[int, list[dict[str, Any]]] = {turn: [] for turn in turns}
        async for raw in cursor:
            raw.pop("_id", None)
            turn = raw.get("turn")
            if isinstance(turn, int):
                raw_by_turn.setdefault(turn, []).append(raw)

        turn_ids = [self._turn_id(turn) for turn in turns]
        await self._chat_messages_col.delete_many(
            {"session_id": session.session_id, "turn_id": {"$in": turn_ids}}
        )

        projection_docs: list[dict[str, Any]] = []
        for turn in turns:
            projection_docs.extend(
                self._build_chat_messages_for_turn(session, turn, raw_by_turn.get(turn, []))
            )
        if projection_docs:
            await self._chat_messages_col.insert_many(projection_docs, ordered=True)

    def _build_chat_messages_for_turn(
        self,
        session: Session,
        turn: int,
        docs: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not docs:
            return []

        turn_id = self._turn_id(turn)
        seqs = [int(doc.get("seq", 0)) for doc in docs]
        seq_start = min(seqs)
        seq_end = max(seqs)
        created_at = str(docs[0].get("created_at") or _iso_now())
        updated_at = str(docs[-1].get("created_at") or created_at)
        out: list[dict[str, Any]] = []
        assistant_parts: list[dict[str, Any]] = []
        assistant_status = "complete"
        tool_parts: dict[str, dict[str, Any]] = {}

        for doc in docs:
            role = doc.get("role")
            if role == "user":
                text = _message_text(doc.get("content")).strip()
                parts = [{"type": "text", "text": text}] if text else []
                metadata = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else None
                out.append(
                    ChatProjectionMessageDoc(
                        message_id=f"{session.session_id}:{turn_id}:user",
                        session_id=session.session_id,
                        turn_id=turn_id,
                        role="user",
                        status="complete",
                        parts=parts,
                        metadata=metadata,
                        seq_start=int(doc.get("seq", seq_start)),
                        seq_end=int(doc.get("seq", seq_start)),
                        created_at=str(doc.get("created_at") or created_at),
                        updated_at=str(doc.get("created_at") or created_at),
                    ).model_dump(exclude_none=True)
                )
                continue

            if role == "assistant":
                text = _message_text(doc.get("content")).strip()
                if text:
                    assistant_parts.append({"type": "text", "text": text})
                if doc.get("status") == "error":
                    assistant_status = "failed"
                continue

            if role == "tool_call":
                tool_call = doc.get("tool_call") if isinstance(doc.get("tool_call"), dict) else {}
                tool_name = str(doc.get("tool_name") or tool_call.get("tool_name") or "")
                tool_call_id = str(
                    doc.get("tool_call_id") or tool_call.get("tool_call_id") or ""
                )
                if not tool_name or not tool_call_id:
                    continue
                part = {
                    "type": "tool_step",
                    "part_id": f"tool:{tool_call_id}",
                    "tool_name": tool_name,
                    "title": tool_name,
                    "status": "running",
                }
                tool_parts[tool_call_id] = part
                assistant_parts.append(part)
                continue

            if role == "tool_result":
                tool_call_id = str(doc.get("tool_call_id") or "")
                part = tool_parts.get(tool_call_id)
                if part:
                    part["status"] = "error" if doc.get("status") == "error" else "success"
                    if doc.get("error"):
                        part["summary"] = str(doc["error"])
                continue

            if role == "tool_event":
                event_name = doc.get("event")
                event_data = (
                    doc.get("event_data") if isinstance(doc.get("event_data"), dict) else {}
                )
                if event_name == "hitl.request":
                    hitl = self._hitl_part(doc, event_data)
                    if hitl is not None:
                        assistant_parts.append(hitl)
                        assistant_status = "waiting_hitl"
                elif event_name == "hitl.resolved":
                    self._resolve_hitl_part(assistant_parts, doc, event_data)
                    assistant_status = "complete"

        if assistant_parts:
            out.append(
                ChatProjectionMessageDoc(
                    message_id=f"{session.session_id}:{turn_id}:assistant",
                    session_id=session.session_id,
                    turn_id=turn_id,
                    role="assistant",
                    status=assistant_status,
                    parts=assistant_parts,
                    metadata={"feedback_turn": turn},
                    seq_start=seq_start,
                    seq_end=seq_end,
                    created_at=created_at,
                    updated_at=updated_at,
                ).model_dump(exclude_none=True)
            )
        return out

    @staticmethod
    def _hitl_part(doc: dict[str, Any], event_data: dict[str, Any]) -> dict[str, Any] | None:
        hitl_type = event_data.get("type")
        if hitl_type not in {"select", "ask"}:
            return None
        nested = event_data.get("data") if isinstance(event_data.get("data"), dict) else {}
        data = _normalize_hitl_data({**event_data, **nested})
        payload: dict[str, Any] = {"message": data.get("message", "")}
        if hitl_type == "select":
            payload["options"] = data.get("options", [])
        else:
            payload["questions"] = data.get("questions") or [
                {
                    "id": "q-1",
                    "title": data.get("message") or "请补充信息",
                    "options": [],
                    "allow_attachments": False,
                }
            ]
        if data.get("title"):
            payload["title"] = data["title"]
        hitl_id = str(doc.get("tool_call_id") or "")
        return {
            "type": "hitl",
            "part_id": f"hitl:{hitl_id}",
            "hitl_id": hitl_id,
            "hitl_type": hitl_type,
            "status": "pending",
            "data": payload,
        }

    @staticmethod
    def _resolve_hitl_part(
        parts: list[dict[str, Any]],
        doc: dict[str, Any],
        event_data: dict[str, Any],
    ) -> None:
        hitl_id = str(doc.get("tool_call_id") or "")
        for part in reversed(parts):
            if part.get("type") != "hitl" or part.get("hitl_id") != hitl_id:
                continue
            part["status"] = "resolved"
            data = part.setdefault("data", {})
            for key in (
                "selected_option_id",
                "submitted_reply_label",
                "submitted_reply_text",
                "reply_text",
            ):
                if isinstance(event_data.get(key), str):
                    data[key] = event_data[key]
            if isinstance(event_data.get("answers"), list):
                data["answers"] = event_data["answers"]
            return

    @staticmethod
    def _normalize_projection_hitl_parts(message: dict[str, Any]) -> None:
        parts = message.get("parts")
        if not isinstance(parts, list):
            return
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "hitl":
                part["data"] = _normalize_hitl_data(part.get("data"))

    @staticmethod
    def _pipeline_state_from_metadata(metadata: dict[str, Any]) -> dict[str, Any] | None:
        tasks = metadata.get("tasks")
        if isinstance(tasks, list):
            return {
                "tasks": tasks,
                "pipeline_id": metadata.get("pipeline_id"),
                "pipeline_step": metadata.get("pipeline_step"),
            }
        if metadata.get("pipeline_id"):
            return {
                "pipeline_id": metadata.get("pipeline_id"),
                "pipeline_step": metadata.get("pipeline_step"),
            }
        return None

    async def _write_redis(self, session: Session) -> None:
        if self._redis is None:
            return
        meta_key = f"{REDIS_META_PREFIX}{session.session_id}"
        ctx_key = f"{REDIS_CTX_PREFIX}{session.session_id}"
        meta_doc = {
            "session_id": session.session_id,
            "user_id": session.user_id,
            "workflow_id": session.workflow_id,
            "channel": session.channel,
            "summary": session.summary,
            "message_count": session.message_count,
            "turn_count": session.turn_count,
            "status": session.status,
            "revision": session.revision,
            "last_seq": session.last_seq,
            "last_message_preview": session.last_message_preview,
            "current_hitl": session.current_hitl,
            "pipeline_state": session.pipeline_state,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "metadata": session.metadata,
        }
        ctx_doc = {
            **meta_doc,
            "messages": session.messages,
            "_persisted_count": session._persisted_count,
        }
        try:
            await self._redis.set(
                meta_key,
                json.dumps(meta_doc, default=_json_default),
                ex=REDIS_TTL_SECONDS,
            )
            await self._redis.set(
                ctx_key,
                json.dumps(ctx_doc, default=_json_default),
                ex=REDIS_TTL_SECONDS,
            )
        except Exception:
            logger.warning(
                "failed to write session cache: session_id=%s",
                session.session_id,
                exc_info=True,
            )

    async def _load_from_redis(self, session_id: str) -> Session | None:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(f"{REDIS_CTX_PREFIX}{session_id}")
            if not raw:
                return None
            doc = json.loads(raw)
            return self._doc_to_session(doc)
        except Exception:
            logger.warning("failed to load session cache: session_id=%s", session_id, exc_info=True)
            return None

    async def _load_from_mongo(self, session_id: str) -> Session | None:
        meta_doc = await self._sessions_col.find_one({"_id": session_id})
        if not meta_doc:
            return None

        messages: list[dict[str, Any]] = []
        cursor = self._messages_col.find({"session_id": session_id}).sort("seq", 1)
        async for message_doc in cursor:
            raw = RawMessageDoc.model_validate(_strip_mongo_fields(message_doc))
            messages.append(raw.model_dump(exclude_none=True))

        doc = {
            **meta_doc,
            "session_id": meta_doc.get("session_id") or session_id,
            "messages": messages,
            "_persisted_count": len(messages),
        }
        return self._doc_to_session(doc)

    @staticmethod
    def _doc_to_session(doc: dict[str, Any]) -> Session:
        now = _utc_now()
        messages = [
            RawMessageDoc.model_validate(message).model_dump(exclude_none=True)
            for message in doc.get("messages", [])
            if isinstance(message, dict)
        ]
        return Session(
            session_id=str(doc.get("session_id") or doc.get("_id")),
            user_id=str(doc.get("user_id") or ""),
            workflow_id=doc.get("workflow_id"),
            channel=str(doc.get("channel") or "api"),
            messages=messages,
            created_at=_coerce_datetime(doc.get("created_at"), now),
            updated_at=_coerce_datetime(doc.get("updated_at"), now),
            summary=doc.get("summary"),
            message_count=int(doc.get("message_count", 0)),
            turn_count=int(doc.get("turn_count", 0)),
            status=str(doc.get("status") or "idle"),
            revision=int(doc.get("revision", 0)),
            last_seq=int(doc.get("last_seq", 0)),
            last_message_preview=doc.get("last_message_preview"),
            current_hitl=_normalize_current_hitl(doc.get("current_hitl")),
            pipeline_state=(
                doc.get("pipeline_state") if isinstance(doc.get("pipeline_state"), dict) else None
            ),
            metadata=doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {},
            _persisted_count=int(doc.get("_persisted_count", len(messages))),
        )

    async def _redis_delete(self, key: str) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.delete(key)
        except Exception:
            logger.warning("failed to delete redis key: key=%s", key, exc_info=True)

    @staticmethod
    def _turn_id(turn: Any) -> str:
        return f"turn:{turn}" if turn is not None else "turn:unknown"
