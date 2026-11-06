"""Redis-backed Agent run event store.

Redis Streams provide a short replay window and live blocking reads for
resumable Agent SSE connections. Durable chat/session facts remain in MongoDB.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

RUN_TTL_SECONDS = 24 * 60 * 60
RUN_STREAM_MAXLEN = 2_000
RELEASE_LOCK_SCRIPT = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"""


@dataclass(slots=True)
class CreatedRun:
    """Result of an idempotent run creation attempt."""

    run_id: str
    created: bool


@dataclass(slots=True)
class StoredRunEvent:
    """One event read from a Redis Stream."""

    redis_id: str
    event: str
    data: dict[str, Any]


class ResumeWindowExpiredError(Exception):
    """Raised when the requested Redis Stream cursor has already been trimmed."""

    def __init__(self, *, run_id: str, last_event_id: str, earliest_event_id: str) -> None:
        super().__init__(
            "Agent run resume window expired: "
            f"run_id={run_id} last_event_id={last_event_id} "
            f"earliest_event_id={earliest_event_id}"
        )
        self.run_id = run_id
        self.last_event_id = last_event_id
        self.earliest_event_id = earliest_event_id


class RedisRunStore:
    """Store resumable Agent run runtime state in Redis Streams and Hashes."""

    ACTIVE_RUNS_KEY = "agent:active_runs"

    def __init__(
        self,
        redis_client: Any,
        *,
        ttl_seconds: int = RUN_TTL_SECONDS,
        stream_maxlen: int = RUN_STREAM_MAXLEN,
    ) -> None:
        if redis_client is None:
            raise ValueError("redis_client is required")
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds
        self._stream_maxlen = stream_maxlen

    async def create_run(
        self,
        *,
        user_id: str,
        session_id: str,
        flow_id: str,
        client_request_id: str,
        request: dict[str, Any],
    ) -> CreatedRun:
        """Create a run once per client request id."""

        request_key = self.request_key(user_id, session_id, client_request_id)
        run_id = f"run_{uuid4().hex[:16]}"
        did_create = await self._redis.set(
            request_key,
            run_id,
            ex=self._ttl_seconds,
            nx=True,
        )
        if not did_create:
            existing_run_id = await self._redis.get(request_key)
            return CreatedRun(run_id=_redis_value_to_str(existing_run_id), created=False)

        now = _now_iso()
        await self._redis.hset(
            self.meta_key(run_id),
            mapping={
                "run_id": run_id,
                "user_id": user_id,
                "session_id": session_id,
                "flow_id": flow_id,
                "client_request_id": client_request_id,
                "status": "queued",
                "last_event_id": "0-0",
                "request": _json_dumps(request),
                "created_at": now,
                "updated_at": now,
            },
        )
        await self._redis.set(
            self.active_run_key(session_id),
            run_id,
            ex=self._ttl_seconds,
        )
        await self.add_active_run(run_id)
        await self._refresh_ttl(run_id, session_id=session_id, request_key=request_key)
        return CreatedRun(run_id=run_id, created=True)

    async def get_run_meta(self, run_id: str) -> dict[str, str]:
        """Return run metadata with Redis byte values normalized to strings."""

        raw = await self._redis.hgetall(self.meta_key(run_id))
        return {_redis_value_to_str(key): _redis_value_to_str(value) for key, value in raw.items()}

    async def get_active_run_id(self, session_id: str) -> str | None:
        value = await self._redis.get(self.active_run_key(session_id))
        return _redis_value_to_str(value) if value else None

    async def get_run_id_for_request(
        self,
        *,
        user_id: str,
        session_id: str,
        client_request_id: str,
    ) -> str | None:
        value = await self._redis.get(self.request_key(user_id, session_id, client_request_id))
        return _redis_value_to_str(value) if value else None

    async def mark_request_cancelled(
        self,
        *,
        user_id: str,
        session_id: str,
        client_request_id: str,
    ) -> None:
        await self._redis.set(
            self.request_cancel_key(user_id, session_id, client_request_id),
            "1",
            ex=self._ttl_seconds,
        )

    async def is_request_cancelled(
        self,
        *,
        user_id: str,
        session_id: str,
        client_request_id: str,
    ) -> bool:
        value = await self._redis.get(
            self.request_cancel_key(user_id, session_id, client_request_id)
        )
        return bool(value)

    async def request_run_cancel(self, run_id: str) -> None:
        """Publish a cross-instance cancellation request."""

        await self._redis.set(self.run_cancel_key(run_id), "1", ex=self._ttl_seconds)

    async def is_run_cancel_requested(self, run_id: str) -> bool:
        return bool(await self._redis.get(self.run_cancel_key(run_id)))

    async def acquire_session_run_lock(
        self,
        session_id: str,
        owner: str,
        *,
        ttl_seconds: int = 10,
    ) -> bool:
        return bool(
            await self._redis.set(
                self.session_run_lock_key(session_id),
                owner,
                ex=ttl_seconds,
                nx=True,
            )
        )

    async def release_session_run_lock(self, session_id: str, owner: str) -> None:
        await self._redis.eval(RELEASE_LOCK_SCRIPT, 1, self.session_run_lock_key(session_id), owner)

    async def append_event(self, run_id: str, event: str, data: dict[str, Any]) -> str:
        """Append one event to the run stream and update run status."""

        meta = await self.get_run_meta(run_id)
        if not meta:
            raise KeyError(f"Agent run not found: {run_id}")

        redis_id = await self._redis.xadd(
            self.stream_key(run_id),
            {"event": event, "data": _json_dumps(data)},
            maxlen=self._stream_maxlen,
            approximate=True,
        )
        redis_id_text = _redis_value_to_str(redis_id)
        next_status = self._status_after_event(event, meta.get("status", "running"), data)
        await self._redis.hset(
            self.meta_key(run_id),
            mapping={
                "last_event_id": redis_id_text,
                "status": next_status,
                "updated_at": _now_iso(),
            },
        )
        await self._refresh_ttl(run_id, session_id=meta.get("session_id"))

        if self._is_terminal_event(event) and next_status in {"completed", "failed", "cancelled"}:
            await self._clear_active_run(meta.get("session_id", ""), run_id)
            await self.remove_active_run(run_id)

        return redis_id_text

    async def read_events(
        self,
        run_id: str,
        *,
        last_event_id: str = "0-0",
        count: int = 100,
        block_ms: int | None = None,
    ) -> list[StoredRunEvent]:
        """Read events after ``last_event_id`` from the run stream."""

        await self.ensure_resume_available(run_id, last_event_id=last_event_id)
        entries = await self._redis.xread(
            {self.stream_key(run_id): last_event_id or "0-0"},
            count=count,
            block=block_ms,
        )
        events: list[StoredRunEvent] = []
        for _stream_key, stream_entries in entries or []:
            for redis_id, fields in stream_entries:
                normalized_fields = {
                    _redis_value_to_str(key): _redis_value_to_str(value)
                    for key, value in fields.items()
                }
                events.append(
                    StoredRunEvent(
                        redis_id=_redis_value_to_str(redis_id),
                        event=normalized_fields.get("event", ""),
                        data=json.loads(normalized_fields.get("data", "{}")),
                    )
                )
        return events

    async def ensure_resume_available(self, run_id: str, *, last_event_id: str) -> None:
        """Raise when an Agent stream id is older than the retained window.

        ``last_event_id`` is a Redis stream id for this Agent run. Canvas run
        recovery stays on the Publisher WebSocket and the Consumer snapshot.
        """

        if not last_event_id or last_event_id == "0-0":
            return
        earliest_event_id = await self._earliest_event_id(run_id)
        if earliest_event_id and _redis_id_gt(earliest_event_id, last_event_id):
            raise ResumeWindowExpiredError(
                run_id=run_id,
                last_event_id=last_event_id,
                earliest_event_id=earliest_event_id,
            )

    async def mark_status(self, run_id: str, status: str) -> None:
        meta = await self.get_run_meta(run_id)
        await self._redis.hset(
            self.meta_key(run_id),
            mapping={"status": status, "updated_at": _now_iso()},
        )
        await self._refresh_ttl(run_id, session_id=meta.get("session_id") if meta else None)

    async def write_checkpoint(self, run_id: str, checkpoint: dict[str, Any]) -> None:
        payload = {**checkpoint, "checkpointed_at": _now_iso()}
        await self._redis.set(
            self.checkpoint_key(run_id),
            _json_dumps(payload),
            ex=self._ttl_seconds,
        )

    async def read_checkpoint(self, run_id: str) -> dict[str, Any] | None:
        raw = await self._redis.get(self.checkpoint_key(run_id))
        if not raw:
            return None
        return json.loads(_redis_value_to_str(raw))

    async def delete_checkpoint(self, run_id: str) -> None:
        await self._redis.delete(self.checkpoint_key(run_id))

    async def set_owner_instance(self, run_id: str, instance_id: str) -> None:
        await self._redis.hset(self.meta_key(run_id), "owner_instance", instance_id)
        await self._refresh_ttl(run_id)

    async def refresh_instance_heartbeat(self, instance_id: str, ttl_seconds: int = 10) -> None:
        await self._redis.set(
            self.instance_heartbeat_key(instance_id),
            "1",
            ex=ttl_seconds,
        )

    async def is_instance_alive(self, instance_id: str) -> bool:
        return bool(await self._redis.exists(self.instance_heartbeat_key(instance_id)))

    async def add_active_run(self, run_id: str) -> None:
        await self._redis.sadd(self.ACTIVE_RUNS_KEY, run_id)

    async def remove_active_run(self, run_id: str) -> None:
        await self._redis.srem(self.ACTIVE_RUNS_KEY, run_id)

    async def get_active_runs(self) -> set[str]:
        members = await self._redis.smembers(self.ACTIVE_RUNS_KEY)
        return {_redis_value_to_str(member) for member in members} if members else set()

    async def _clear_active_run(self, session_id: str, run_id: str) -> None:
        if not session_id:
            return
        key = self.active_run_key(session_id)
        current = await self._redis.get(key)
        if current and _redis_value_to_str(current) == run_id:
            await self._redis.delete(key)

    async def _refresh_ttl(
        self,
        run_id: str,
        *,
        session_id: str | None = None,
        request_key: str | None = None,
    ) -> None:
        await self._redis.expire(self.meta_key(run_id), self._ttl_seconds)
        await self._redis.expire(self.stream_key(run_id), self._ttl_seconds)
        await self._redis.expire(self.run_cancel_key(run_id), self._ttl_seconds)
        await self._redis.expire(self.checkpoint_key(run_id), self._ttl_seconds)
        if session_id:
            await self._redis.expire(self.active_run_key(session_id), self._ttl_seconds)
        if request_key:
            await self._redis.expire(request_key, self._ttl_seconds)

    @staticmethod
    def _is_terminal_event(event: str) -> bool:
        return event in {"run.completed", "run.failed", "run.cancelled"}

    @classmethod
    def _status_after_event(cls, event: str, current: str, data: dict[str, Any]) -> str:
        if event == "agent.started":
            return "running"
        if event == "run.completed":
            return "completed"
        if event == "run.failed":
            return "failed"
        if event == "run.cancelled":
            return "cancelled"
        if event == "tool.event" and data.get("event_name") == "hitl.request":
            return "waiting_hitl"
        if event == "hitl.request":
            return "waiting_hitl"
        if event == "chat.message.completed" and data.get("status") == "waiting_hitl":
            return "waiting_hitl"
        if event == "session.state.updated":
            state = data.get("state")
            if isinstance(state, dict) and state.get("status") == "waiting_hitl":
                return "waiting_hitl"
        return current if current != "queued" else "running"

    async def _earliest_event_id(self, run_id: str) -> str | None:
        entries = await self._redis.xrange(self.stream_key(run_id), count=1)
        if not entries:
            return None
        return _redis_value_to_str(entries[0][0])

    @staticmethod
    def stream_key(run_id: str) -> str:
        return f"agent:run:{run_id}:events"

    @staticmethod
    def meta_key(run_id: str) -> str:
        return f"agent:run:{run_id}:meta"

    @staticmethod
    def active_run_key(session_id: str) -> str:
        return f"agent:session:{session_id}:active_run"

    @staticmethod
    def request_key(user_id: str, session_id: str, client_request_id: str) -> str:
        return f"agent:req:{user_id}:{session_id}:{client_request_id}"

    @staticmethod
    def request_cancel_key(user_id: str, session_id: str, client_request_id: str) -> str:
        return f"agent:req_cancel:{user_id}:{session_id}:{client_request_id}"

    @staticmethod
    def run_cancel_key(run_id: str) -> str:
        return f"agent:run:{run_id}:cancel_requested"

    @staticmethod
    def session_run_lock_key(session_id: str) -> str:
        return f"agent:session:{session_id}:run_lock"

    @staticmethod
    def checkpoint_key(run_id: str) -> str:
        return f"agent:run:{run_id}:checkpoint"

    @staticmethod
    def instance_heartbeat_key(instance_id: str) -> str:
        return f"agent:instance:{instance_id}:heartbeat"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _redis_id_gt(left: str, right: str) -> bool:
    left_ms, left_seq = (int(part) for part in left.split("-", 1))
    right_ms, right_seq = (int(part) for part in right.split("-", 1))
    return (left_ms, left_seq) > (right_ms, right_seq)


def _redis_value_to_str(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)
