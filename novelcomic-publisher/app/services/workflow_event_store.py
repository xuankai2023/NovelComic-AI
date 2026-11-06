"""Workflow run event store and replay helpers."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings
from app.database.mongo import FLOW_TASK


class WorkflowEventStore:
    COLLECTION = "workflow_events"
    NOTIFICATION_STREAM = "opencreator:workflow:v2:event-notifications"
    NOTIFICATION_CHANNEL = "opencreator:workflow:v2:event-notifications"
    PROTOCOL_VERSION = 2

    # KEYS: event stream, event_id → cursor hash, notification stream
    # ARGV: event_id, payload, flow_task_id, ttl, maxlen, channel
    # 已有 event_id 返回原 cursor 且 inserted=0；否则 XADD → HSET → EXPIRE → PUBLISH。
    _APPEND_EVENT_SCRIPT = """
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then
  return {existing, '0'}
end
local cursor = redis.call(
  'XADD',
  KEYS[1],
  'MAXLEN',
  '~',
  ARGV[5],
  '*',
  'event_id',
  ARGV[1],
  'event',
  ARGV[2]
)
redis.call('HSET', KEYS[2], ARGV[1], cursor)
redis.call(
  'XADD',
  KEYS[3],
  'MAXLEN',
  '~',
  ARGV[5],
  '*',
  'flow_task_id',
  ARGV[3],
  'cursor',
  cursor,
  'event_id',
  ARGV[1]
)
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
redis.call('PUBLISH', ARGV[6], ARGV[3] .. '|' .. cursor .. '|' .. ARGV[1])
return {cursor, '1'}
"""

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @classmethod
    def _stream_key(cls, flow_task_id: str) -> str:
        return f"workflow:v2:events:{flow_task_id}"

    @classmethod
    def _dedupe_key(cls, flow_task_id: str) -> str:
        return f"workflow:v2:event-cursors:{flow_task_id}"

    @classmethod
    def _generation_key(cls, flow_task_id: str, connection_id: str) -> str:
        return f"workflow:v2:connection-generation:{flow_task_id}:{connection_id}"

    @staticmethod
    def _cursor_tuple(cursor: str) -> tuple[int, int]:
        try:
            left, right = str(cursor).split("-", 1)
            return int(left), int(right)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid event cursor") from exc

    @classmethod
    def _stable_event_id(
        cls,
        *,
        flow_task_id: str,
        event_type: str,
        payload: dict[str, Any] | None,
    ) -> str:
        canonical = json.dumps(
            [flow_task_id, event_type, payload or {}],
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @classmethod
    def _normalize_event(
        cls,
        *,
        flow_task_id: str,
        event_type: str | None = None,
        payload: dict[str, Any] | None = None,
        event: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if event is not None:
            normalized = dict(event)
            normalized["flow_task_id"] = str(normalized.get("flow_task_id") or flow_task_id)
            normalized["event_type"] = str(
                normalized.get("event_type") or normalized.get("event") or event_type or ""
            )
            normalized.setdefault("payload", payload or {})
            normalized.setdefault("protocol_version", cls.PROTOCOL_VERSION)
            normalized.setdefault(
                "event_id",
                cls._stable_event_id(
                    flow_task_id=normalized["flow_task_id"],
                    event_type=normalized["event_type"],
                    payload=normalized.get("payload") or {},
                ),
            )
            normalized.setdefault("created_at", cls._now().isoformat())
            return normalized

        resolved_type = str(event_type or "")
        resolved_payload = payload or {}
        return {
            "created_at": cls._now().isoformat(),
            "event_id": cls._stable_event_id(
                flow_task_id=flow_task_id,
                event_type=resolved_type,
                payload=resolved_payload,
            ),
            "event_type": resolved_type,
            "flow_task_id": flow_task_id,
            "payload": resolved_payload,
            "protocol_version": cls.PROTOCOL_VERSION,
        }

    @staticmethod
    def _decode(value: Any) -> str:
        if isinstance(value, bytes):
            return value.decode()
        return str(value)

    @classmethod
    def ensure_event_identity(
        cls,
        *,
        flow_task_id: str,
        event: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        normalized = cls._normalize_event(flow_task_id=flow_task_id, event=event)
        return str(normalized["event_id"]), normalized

    @classmethod
    async def append_event(
        cls,
        database: Any,
        flow_task_id: str,
        event_type: str | None = None,
        payload: dict[str, Any] | None = None,
        *,
        redis_client: Any | None = None,
        event: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one logical event. A repeated event_id returns the original cursor.

        The Redis path runs ``_APPEND_EVENT_SCRIPT``. ``inserted`` is true only
        when this call performed the XADD. A duplicate still returns a cursor so
        the caller can ACK after the event is addressable.
        """
        normalized = cls._normalize_event(
            flow_task_id=flow_task_id,
            event_type=event_type,
            payload=payload,
            event=event,
        )
        if redis_client is None:
            legacy_event = {
                "created_at": datetime.now(UTC),
                "cursor": normalized["event_id"],
                "event": normalized["event_type"],
                "event_id": normalized["event_id"],
                "flow_task_id": normalized["flow_task_id"],
                "payload": normalized.get("payload") or {},
            }
            await database[cls.COLLECTION].update_one(
                {"flow_task_id": flow_task_id, "event_id": normalized["event_id"]},
                {"$setOnInsert": legacy_event},
                upsert=True,
            )
            return {key: value for key, value in legacy_event.items() if key != "_id"}

        event_json = json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
        settings = get_settings()
        cursor = await redis_client.eval(
            cls._APPEND_EVENT_SCRIPT,
            3,
            cls._stream_key(flow_task_id),
            cls._dedupe_key(flow_task_id),
            cls.NOTIFICATION_STREAM,
            normalized["event_id"],
            event_json,
            flow_task_id,
            str(settings.workflow_event_stream_ttl_seconds),
            str(settings.workflow_event_stream_maxlen),
            cls.NOTIFICATION_CHANNEL,
        )
        inserted = True
        if isinstance(cursor, (list, tuple)):
            inserted = cls._decode(cursor[1]) == "1" if len(cursor) > 1 else True
            cursor = cursor[0]
        normalized["cursor"] = cls._decode(cursor)
        normalized["inserted"] = inserted
        return normalized

    @classmethod
    async def replay(
        cls,
        database: Any,
        flow_task_id: str,
        cursor: str | None,
        *,
        redis_client: Any | None = None,
        count: int | None = None,
        through_cursor: str | None = None,
    ) -> list[dict[str, Any]]:
        if cursor:
            cls._cursor_tuple(cursor)
        if through_cursor:
            cls._cursor_tuple(through_cursor)
        if redis_client is not None:
            min_id = f"({cursor}" if cursor else "-"
            kwargs: dict[str, Any] = {}
            if count is not None:
                kwargs["count"] = count
            entries = await redis_client.xrange(
                cls._stream_key(flow_task_id),
                min=min_id,
                max=through_cursor or "+",
                **kwargs,
            )
            events: list[dict[str, Any]] = []
            for entry_id, fields in entries:
                raw_event = fields.get(b"event") or fields.get("event")
                if raw_event is None:
                    continue
                event = json.loads(cls._decode(raw_event))
                event["cursor"] = cls._decode(entry_id)
                events.append(event)
            return events

        query: dict[str, Any] = {"flow_task_id": flow_task_id}
        if cursor:
            query["cursor"] = {"$gt": cursor}

        events: list[dict[str, Any]] = []
        db_cursor = database[cls.COLLECTION].find(query, {"_id": 0}).sort("created_at", 1)
        async for event in db_cursor:
            if through_cursor and cls._cursor_tuple(str(event.get("cursor"))) > cls._cursor_tuple(
                through_cursor
            ):
                continue
            events.append(event)
        return events

    @classmethod
    async def replay_after(
        cls,
        database: Any,
        flow_task_id: str,
        cursor: str | None,
        *,
        redis_client: Any | None = None,
        count: int | None = None,
        through_cursor: str | None = None,
    ) -> list[dict[str, Any]]:
        return await cls.replay(
            database,
            flow_task_id,
            cursor,
            redis_client=redis_client,
            count=count,
            through_cursor=through_cursor,
        )

    @classmethod
    async def latest_cursor(
        cls,
        flow_task_id: str,
        *,
        redis_client: Any | None,
    ) -> str:
        if redis_client is None:
            return "0-0"
        rows = await redis_client.xrevrange(
            cls._stream_key(flow_task_id),
            max="+",
            min="-",
            count=1,
        )
        if not rows:
            return "0-0"
        return cls._decode(rows[0][0])

    @classmethod
    async def is_cursor_available(
        cls,
        flow_task_id: str,
        cursor: str | None,
        *,
        redis_client: Any | None = None,
        database: Any | None = None,
    ) -> bool:
        if cursor in {None, "", "0-0"}:
            return await cls._zero_cursor_is_available(
                flow_task_id,
                redis_client=redis_client,
                database=database,
            )
        cursor_tuple = cls._cursor_tuple(str(cursor))
        if redis_client is None:
            return True

        entries = await redis_client.xrange(
            cls._stream_key(flow_task_id),
            min="-",
            max="+",
            count=1,
        )
        if not entries:
            return False

        first_cursor = cls._decode(entries[0][0])
        return cls._cursor_tuple(first_cursor) <= cursor_tuple

    @classmethod
    async def _zero_cursor_is_available(
        cls,
        flow_task_id: str,
        *,
        redis_client: Any | None,
        database: Any | None,
    ) -> bool:
        """``0-0`` is the start of the stream, not a missing id.

        A trimmed or expired stream cannot be rebuilt from ``0-0`` and needs a
        snapshot. An intact stream, or a run that has never stored a cursor,
        can still replay.
        """

        if redis_client is None:
            return True
        stream_key = cls._stream_key(flow_task_id)
        length = int(await redis_client.xlen(stream_key))
        if length:
            remembered = int(await redis_client.hlen(cls._dedupe_key(flow_task_id)))
            return remembered <= length
        if database is None:
            return True
        task = await database[FLOW_TASK].find_one(
            {"flow_task_id": flow_task_id, "protocol_version": cls.PROTOCOL_VERSION},
            {"last_event_cursor": 1},
        )
        if not task:
            return True
        return task.get("last_event_cursor") in {None, "", "0-0"}

    @classmethod
    async def read_live(
        cls,
        database: Any,
        flow_task_id: str,
        cursor: str | None,
        *,
        redis_client: Any | None = None,
        block_ms: int = 5000,
        count: int = 100,
    ) -> list[dict[str, Any]]:
        if redis_client is None:
            return await cls.replay(database, flow_task_id, cursor, redis_client=None, count=count)
        if cursor:
            cls._cursor_tuple(cursor)
        streams = await redis_client.xread(
            {cls._stream_key(flow_task_id): cursor or "0-0"},
            count=count,
            block=block_ms,
        )
        events: list[dict[str, Any]] = []
        for _stream_name, entries in streams or []:
            for entry_id, fields in entries:
                raw_event = fields.get(b"event") or fields.get("event")
                if raw_event is None:
                    continue
                event = json.loads(cls._decode(raw_event))
                event["cursor"] = cls._decode(entry_id)
                events.append(event)
        return events

    @classmethod
    async def claim_connection_generation(
        cls,
        redis_client: Any | None,
        flow_task_id: str,
        connection_id: str,
    ) -> int:
        if redis_client is None:
            return 1
        key = cls._generation_key(flow_task_id, connection_id)
        generation = int(await redis_client.incr(key))
        await redis_client.expire(key, get_settings().workflow_event_stream_ttl_seconds)
        return generation

    @classmethod
    async def is_current_generation(
        cls,
        redis_client: Any | None,
        flow_task_id: str,
        connection_id: str,
        generation: int,
    ) -> bool:
        if redis_client is None:
            return True
        key = cls._generation_key(flow_task_id, connection_id)
        current = await redis_client.get(key)
        if current is None:
            return False
        if int(cls._decode(current)) != generation:
            return False
        await redis_client.expire(key, get_settings().workflow_event_stream_ttl_seconds)
        return True
