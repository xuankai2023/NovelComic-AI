"""Durable workflow v2 run commands and Publisher dispatch."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.database.mongo import FLOW_TASK, WORKFLOW_COMMAND, mongo_transaction
from app.schemas.workflow_runs_v2 import (
    ContinueWorkflowRunRequest,
    CreateWorkflowRunRequest,
    WorkflowRunResponse,
)
from app.services.flow import FlowService
from app.utils.id_utils import generate_trace_id

V2_REPLY_QUEUE_NAME = get_settings().v2_reply_queue
ACTIVE_RUN_STATUSES = (
    "pending",
    "running",
    "waiting_for_selection",
    "cancel_requested",
)
CONTINUABLE_RUN_STATUSES = ("waiting_for_selection",)
TERMINAL_RUN_STATUSES = ("cancelled", "completed", "failed", "killed")
logger = logging.getLogger(__name__)


class WorkflowRunConflict(Exception):
    """Raised when a stable client command id is reused with a different payload."""


class WorkflowRunInvalid(Exception):
    """Raised when the workflow graph cannot be dispatched."""


class WorkflowRunV2Service:
    PROTOCOL_VERSION = 2
    COMMAND_COLLECTION = WORKFLOW_COMMAND
    RUN_COLLECTION = FLOW_TASK

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    @classmethod
    def _canonical_json(cls, value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)

    @classmethod
    def _payload_hash(cls, value: Any) -> str:
        return hashlib.sha256(cls._canonical_json(value).encode("utf-8")).hexdigest()

    @staticmethod
    def _wire_command_id(user_id: str, command_id: str) -> str:
        digest = hashlib.sha256(f"{user_id}\0{command_id}".encode("utf-8")).hexdigest()
        return f"wfc_{digest[:40]}"

    @classmethod
    def _validate_graph(cls, flow_task: Any) -> None:
        if not isinstance(flow_task, dict):
            raise WorkflowRunInvalid("flow_task must be an object")
        nodes = flow_task.get("nodes", [])
        edges = flow_task.get("edges", [])
        if not isinstance(nodes, list) or not isinstance(edges, list):
            raise WorkflowRunInvalid("flow_task.nodes and flow_task.edges must be arrays")
        try:
            filtered_nodes, filtered_edges = FlowService.filter_non_executable_nodes_with_edges(
                node_list=nodes,
                edge_list=edges,
            )
            FlowService._build_dag(filtered_nodes, filtered_edges)
        except WorkflowRunInvalid:
            raise
        except Exception as exc:
            raise WorkflowRunInvalid(f"invalid workflow graph: {exc}") from exc

    @classmethod
    def _session_write(cls, session: Any) -> dict[str, Any]:
        return {} if session is None else {"session": session}

    @staticmethod
    def _dump_response(run: dict[str, Any], *, idempotent_replay: bool) -> WorkflowRunResponse:
        return WorkflowRunResponse(
            flow_task_id=run["flow_task_id"],
            flow_run_id=run["flow_run_id"],
            trace_id=run["trace_id"],
            status=run.get("status") or "pending",
            idempotent_replay=idempotent_replay,
            flow_id=run.get("flow_id"),
            flow_task=run.get("flow_task"),
            created_at=run.get("created_at"),
            updated_at=run.get("updated_at"),
        )

    @classmethod
    def _start_payload(cls, request: CreateWorkflowRunRequest) -> dict[str, Any]:
        return request.model_dump(exclude={"client_request_id", "command_id"}, mode="json")

    @classmethod
    def _bind_trace_id(cls, run: dict[str, Any]) -> bool:
        """任务上没有 trace_id 时新造一张。返回值表示这次是新造的。"""

        current = run.get("trace_id")
        if isinstance(current, str) and current and current != "-":
            return False
        run["trace_id"] = generate_trace_id()
        return True

    @classmethod
    def _command_document(
        cls,
        *,
        user_id: str,
        command_id: str,
        command_type: str = "start",
        payload: dict[str, Any],
        payload_hash: str,
        run: dict[str, Any],
        status: str = "pending",
    ) -> dict[str, Any]:
        now = cls._now()
        cls._bind_trace_id(run)
        document = {
            "attempts": 0,
            "command_id": command_id,
            "command_type": command_type,
            "created_at": now,
            "flow_run_id": run["flow_run_id"],
            "flow_task_id": run["flow_task_id"],
            "next_attempt_at": now,
            "payload": payload,
            "payload_hash": payload_hash,
            "protocol_version": cls.PROTOCOL_VERSION,
            "status": status,
            "trace_id": run["trace_id"],
            "updated_at": now,
            "user_id": user_id,
            "wire_command_id": cls._wire_command_id(user_id, command_id),
        }
        if status == "dispatched":
            document["expires_at"] = now + timedelta(
                days=get_settings().workflow_command_retention_days
            )
        return document

    @classmethod
    async def _existing_command(
        cls,
        database: Any,
        *,
        user_id: str,
        command_id: str,
    ) -> dict[str, Any] | None:
        return await database[cls.COMMAND_COLLECTION].find_one(
            {"user_id": user_id, "command_id": command_id}
        )

    @classmethod
    async def _resolve_replay(
        cls,
        database: Any,
        *,
        user_id: str,
        command_id: str,
        payload_hash: str,
    ) -> WorkflowRunResponse | None:
        command = await cls._existing_command(database, user_id=user_id, command_id=command_id)
        if command is None:
            return None
        if command.get("payload_hash") != payload_hash:
            raise WorkflowRunConflict("command_id was already used with a different payload")

        run = await database[cls.RUN_COLLECTION].find_one(
            {"user_id": user_id, "flow_task_id": command["flow_task_id"]}
        )
        if run is None:
            raise WorkflowRunConflict("idempotent command exists without its workflow run")
        return cls._dump_response(run, idempotent_replay=True)

    @classmethod
    async def _existing_start_task(
        cls,
        database: Any,
        *,
        user_id: str,
        client_request_id: str,
    ) -> dict[str, Any] | None:
        return await database[cls.RUN_COLLECTION].find_one(
            {"user_id": user_id, "client_request_id": client_request_id}
        )

    @classmethod
    async def _reserve_start_replay_alias(
        cls,
        database: Any,
        *,
        user_id: str,
        command_id: str,
        command_hash: str,
        command_payload: dict[str, Any],
        task: dict[str, Any],
    ) -> WorkflowRunResponse:
        alias = cls._command_document(
            user_id=user_id,
            command_id=command_id,
            payload=command_payload,
            payload_hash=command_hash,
            run=task,
            status="dispatched",
        )
        try:
            await database[cls.COMMAND_COLLECTION].insert_one(alias)
        except DuplicateKeyError:
            replay = await cls._resolve_replay(
                database,
                user_id=user_id,
                command_id=command_id,
                payload_hash=command_hash,
            )
            if replay is not None:
                return replay
            raise
        return cls._dump_response(task, idempotent_replay=True)

    @classmethod
    async def _replay_or_alias_start(
        cls,
        database: Any,
        *,
        user_id: str,
        command_id: str,
        client_request_id: str,
        command_hash: str,
        request_hash: str,
        command_payload: dict[str, Any],
    ) -> WorkflowRunResponse | None:
        replay = await cls._resolve_replay(
            database,
            user_id=user_id,
            command_id=command_id,
            payload_hash=command_hash,
        )
        if replay is not None:
            return replay
        existing = await cls._existing_start_task(
            database,
            user_id=user_id,
            client_request_id=client_request_id,
        )
        if existing is None:
            return None
        if existing.get("request_hash") != request_hash:
            raise WorkflowRunConflict(
                "client_request_id was already used with a different payload"
            )
        return await cls._reserve_start_replay_alias(
            database,
            user_id=user_id,
            command_id=command_id,
            command_hash=command_hash,
            command_payload=command_payload,
            task=existing,
        )

    @classmethod
    async def create_run(
        cls,
        *,
        database: Any,
        redis_client: Any,
        request: CreateWorkflowRunRequest,
        user_id: str,
    ) -> WorkflowRunResponse:
        command_id = request.command_id or request.client_request_id
        business_payload = cls._start_payload(request)
        request_hash = cls._payload_hash(business_payload)
        command_payload = {
            "client_request_id": request.client_request_id,
            "command_type": "start",
            "request": business_payload,
        }
        payload_hash = cls._payload_hash(command_payload)

        replay = await cls._replay_or_alias_start(
            database,
            user_id=user_id,
            command_id=command_id,
            client_request_id=request.client_request_id,
            command_hash=payload_hash,
            request_hash=request_hash,
            command_payload=command_payload,
        )
        if replay is not None:
            return replay

        cls._validate_graph(request.flow_task)

        now = cls._now()
        run = {
            "client_request_id": request.client_request_id,
            "command_id": command_id,
            "created_at": now,
            "dispatch_state": "pending",
            "end_ids": list(request.end_ids),
            "flow_id": request.flow_id,
            "flow_run_id": uuid4().hex,
            "flow_task": request.flow_task,
            "flow_task_id": uuid4().hex,
            "intent_node_ids": list(request.intent_node_ids),
            "locale": request.locale,
            "protocol_version": cls.PROTOCOL_VERSION,
            "request_hash": request_hash,
            "run_mode": request.run_mode,
            "start_ids": list(request.start_ids),
            "status": "pending",
            "trace_id": generate_trace_id(),
            "updated_at": now,
            "user_id": user_id,
            "user_selection": request.user_selection,
        }
        command = cls._command_document(
            user_id=user_id,
            command_id=command_id,
            payload=command_payload,
            payload_hash=payload_hash,
            run=run,
        )

        try:
            # 两行在同一个事务里。提交之后才允许 dispatch。
            async with mongo_transaction(database) as session:
                write = cls._session_write(session)
                await database[cls.RUN_COLLECTION].insert_one(dict(run), **write)
                try:
                    await database[cls.COMMAND_COLLECTION].insert_one(command, **write)
                except Exception:
                    if session is None:
                        await cls._discard_task_without_command(database, run)
                    raise
        except DuplicateKeyError:
            replay = await cls._replay_or_alias_start(
                database,
                user_id=user_id,
                command_id=command_id,
                client_request_id=request.client_request_id,
                command_hash=payload_hash,
                request_hash=request_hash,
                command_payload=command_payload,
            )
            if replay is not None:
                return replay
            raise

        await cls.dispatch_command(
            database=database,
            redis_client=redis_client,
            user_id=user_id,
            command_id=command_id,
        )
        current = await database[cls.RUN_COLLECTION].find_one(
            {"user_id": user_id, "flow_task_id": run["flow_task_id"]}
        )
        return cls._dump_response(current or run, idempotent_replay=False)

    @classmethod
    async def _discard_task_without_command(cls, database: Any, run: dict[str, Any]) -> None:
        """没有事务时，命令没写上就删掉刚插入的公开任务。"""

        delete_one = getattr(database[cls.RUN_COLLECTION], "delete_one", None)
        if delete_one is None:
            return
        await delete_one({"user_id": run["user_id"], "flow_task_id": run["flow_task_id"]})

    @classmethod
    async def _delete_command(
        cls,
        database: Any,
        *,
        user_id: str,
        command_id: str,
    ) -> None:
        delete_one = getattr(database[cls.COMMAND_COLLECTION], "delete_one", None)
        if delete_one is None:
            return
        await delete_one({"user_id": user_id, "command_id": command_id})

    @classmethod
    async def _insert_command_and_update_run(
        cls,
        database: Any,
        command: dict[str, Any],
        update_filter: dict[str, Any],
        update: dict[str, Any],
        *,
        conflict_message: str,
    ) -> None:
        """命令行和 run 更新在同一个事务里。没有事务时，更新失败就删掉命令行。"""

        async with mongo_transaction(database) as session:
            write = cls._session_write(session)
            await database[cls.COMMAND_COLLECTION].insert_one(command, **write)
            try:
                updated = await database[cls.RUN_COLLECTION].update_one(
                    update_filter, update, **write
                )
                if updated.matched_count != 1:
                    raise WorkflowRunConflict(conflict_message)
            except Exception:
                if session is None:
                    await cls._delete_command(
                        database,
                        user_id=command["user_id"],
                        command_id=command["command_id"],
                    )
                raise

    @classmethod
    async def cancel_run(
        cls,
        *,
        database: Any,
        redis_client: Any,
        user_id: str,
        flow_task_id: str,
        command_id: str,
    ) -> WorkflowRunResponse:
        run = await database[cls.RUN_COLLECTION].find_one(
            {
                "flow_task_id": flow_task_id,
                "protocol_version": cls.PROTOCOL_VERSION,
                "user_id": user_id,
            }
        )
        if run is None:
            raise WorkflowRunConflict("workflow run not found")

        payload = {"command_type": "cancel", "flow_task_id": flow_task_id}
        payload_hash = cls._payload_hash(payload)
        replay = await cls._resolve_replay(
            database,
            user_id=user_id,
            command_id=command_id,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        if run.get("status") not in ACTIVE_RUN_STATUSES:
            raise WorkflowRunConflict("workflow run is not active")

        fresh_trace_id = cls._bind_trace_id(run)
        command = cls._command_document(
            user_id=user_id,
            command_id=command_id,
            command_type="cancel",
            payload=payload,
            payload_hash=payload_hash,
            run=run,
        )
        now = cls._now()
        try:
            await cls._insert_command_and_update_run(
                database,
                command,
                {
                    "flow_task_id": flow_task_id,
                    "protocol_version": cls.PROTOCOL_VERSION,
                    "status": {"$in": list(ACTIVE_RUN_STATUSES)},
                    "user_id": user_id,
                },
                {
                    "$set": {
                        "cancel_command_id": command_id,
                        "current_command_id": command_id,
                        "current_wire_command_id": command["wire_command_id"],
                        "dispatch_state": "pending",
                        "status": "cancel_requested",
                        "updated_at": now,
                        **({"trace_id": run["trace_id"]} if fresh_trace_id else {}),
                    }
                },
                conflict_message="workflow run is no longer active",
            )
        except DuplicateKeyError:
            replay = await cls._resolve_replay(
                database,
                user_id=user_id,
                command_id=command_id,
                payload_hash=payload_hash,
            )
            if replay is not None:
                return replay
            raise

        await cls.dispatch_command(
            database=database,
            redis_client=redis_client,
            user_id=user_id,
            command_id=command_id,
        )
        current = await database[cls.RUN_COLLECTION].find_one(
            {"user_id": user_id, "flow_task_id": flow_task_id}
        )
        return cls._dump_response(current or run, idempotent_replay=False)

    @classmethod
    async def continue_run(
        cls,
        *,
        database: Any,
        redis_client: Any,
        user_id: str,
        flow_task_id: str,
        request: ContinueWorkflowRunRequest,
    ) -> WorkflowRunResponse:
        run = await database[cls.RUN_COLLECTION].find_one(
            {
                "flow_task_id": flow_task_id,
                "protocol_version": cls.PROTOCOL_VERSION,
                "user_id": user_id,
            }
        )
        if run is None:
            raise WorkflowRunConflict("workflow run not found")

        payload = {
            "command_type": "continue",
            "flow_run_id": request.flow_run_id,
            "flow_task": request.flow_task,
            "flow_task_id": flow_task_id,
            "locale": request.locale,
            "start_ids": list(request.start_ids),
            "user_selection": request.user_selection,
        }
        payload_hash = cls._payload_hash(payload)
        replay = await cls._resolve_replay(
            database,
            user_id=user_id,
            command_id=request.command_id,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        if request.flow_run_id != run.get("flow_run_id"):
            raise WorkflowRunConflict("flow_run_id does not match the workflow run")
        if run.get("status") not in CONTINUABLE_RUN_STATUSES:
            raise WorkflowRunConflict("workflow run is not waiting for selection")
        cls._validate_graph(request.flow_task)

        fresh_trace_id = cls._bind_trace_id(run)
        command = cls._command_document(
            user_id=user_id,
            command_id=request.command_id,
            command_type="continue",
            payload=payload,
            payload_hash=payload_hash,
            run=run,
        )
        now = cls._now()
        try:
            await cls._insert_command_and_update_run(
                database,
                command,
                {
                    "flow_run_id": request.flow_run_id,
                    "flow_task_id": flow_task_id,
                    "protocol_version": cls.PROTOCOL_VERSION,
                    "status": {"$in": list(CONTINUABLE_RUN_STATUSES)},
                    "user_id": user_id,
                },
                {
                    "$set": {
                        "command_id": request.command_id,
                        "current_command_id": request.command_id,
                        "current_wire_command_id": command["wire_command_id"],
                        "dispatch_state": "pending",
                        "flow_task": request.flow_task,
                        "locale": request.locale,
                        "start_ids": list(request.start_ids),
                        "status": "running",
                        "updated_at": now,
                        "user_selection": request.user_selection,
                        **({"trace_id": run["trace_id"]} if fresh_trace_id else {}),
                    }
                },
                conflict_message="workflow run is no longer continuable",
            )
        except DuplicateKeyError:
            replay = await cls._resolve_replay(
                database,
                user_id=user_id,
                command_id=request.command_id,
                payload_hash=payload_hash,
            )
            if replay is not None:
                return replay
            raise

        await cls.dispatch_command(
            database=database,
            redis_client=redis_client,
            user_id=user_id,
            command_id=request.command_id,
        )
        current = await database[cls.RUN_COLLECTION].find_one(
            {"user_id": user_id, "flow_task_id": flow_task_id}
        )
        return cls._dump_response(current or run, idempotent_replay=False)

    @classmethod
    async def get_run_summary(
        cls,
        *,
        database: Any,
        user_id: str,
        flow_task_id: str,
    ) -> WorkflowRunResponse | None:
        run = await database[cls.RUN_COLLECTION].find_one(
            {
                "flow_task_id": flow_task_id,
                "protocol_version": cls.PROTOCOL_VERSION,
                "user_id": user_id,
            }
        )
        if run is None:
            return None
        return cls._dump_response(run, idempotent_replay=False)

    @classmethod
    async def _claim_command(
        cls,
        database: Any,
        *,
        user_id: str | None = None,
        command_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = cls._now()
        query: dict[str, Any] = {
            "$or": [
                {"status": "pending", "next_attempt_at": {"$lte": now}},
                {"status": "dispatching", "lease_expires_at": {"$lte": now}},
            ]
        }
        if user_id is not None:
            query["user_id"] = user_id
        if command_id is not None:
            query["command_id"] = command_id

        lease_token = uuid4().hex
        return await database[cls.COMMAND_COLLECTION].find_one_and_update(
            query,
            {
                "$inc": {"attempts": 1},
                "$set": {
                    "lease_expires_at": now
                    + timedelta(seconds=get_settings().workflow_command_dispatch_lease_seconds),
                    "lease_token": lease_token,
                    "status": "dispatching",
                    "updated_at": now,
                },
            },
            sort=[("next_attempt_at", 1), ("created_at", 1)],
            return_document=ReturnDocument.AFTER,
        )

    @classmethod
    async def _dispatch_claimed(
        cls, database: Any, redis_client: Any, command: dict[str, Any]
    ) -> None:
        run = await database[cls.RUN_COLLECTION].find_one(
            {
                "flow_task_id": command["flow_task_id"],
                "protocol_version": cls.PROTOCOL_VERSION,
                "user_id": command["user_id"],
            }
        )
        if run is None:
            raise WorkflowRunConflict("workflow run not found for command")

        command_type = str(command.get("command_type") or "start")
        if command_type != "cancel" and run.get("status") in {
            "cancel_requested",
            "cancelled",
            "killed",
        }:
            return

        command_payload = command.get("payload") or {}
        if command_type == "start" and isinstance(command_payload.get("request"), dict):
            request_payload = command_payload["request"]
        else:
            request_payload = command_payload
        flow_task = (
            {}
            if command_type == "cancel"
            else request_payload.get("flow_task") or run.get("flow_task") or {}
        )
        wire_command_id = command.get("wire_command_id") or cls._wire_command_id(
            command["user_id"], command["command_id"]
        )
        await FlowService.enqueue_flow_task(
            redis_client=redis_client,
            nodes=flow_task.get("nodes") or [],
            edges=flow_task.get("edges") or [],
            reply_channel_id=f"v2:{run['flow_task_id']}",
            flow_task_id=run["flow_task_id"],
            flow_id=run.get("flow_id"),
            flow_run_type=command_type,
            flow_run_id=run["flow_run_id"],
            user_selection=request_payload.get("user_selection") or run.get("user_selection") or {},
            start_ids=request_payload.get("start_ids") or run.get("start_ids") or [],
            end_ids=run.get("end_ids") or [],
            user_id=run["user_id"],
            locale=request_payload.get("locale") or run.get("locale"),
            reply_queue_name=V2_REPLY_QUEUE_NAME,
            trace_id=command["trace_id"],
            command_id=wire_command_id,
            protocol_version=cls.PROTOCOL_VERSION,
        )

        now = cls._now()
        if command_type == "cancel":
            await database[cls.RUN_COLLECTION].update_one(
                {
                    "flow_task_id": run["flow_task_id"],
                    "protocol_version": cls.PROTOCOL_VERSION,
                    "status": "cancel_requested",
                    "user_id": run["user_id"],
                },
                {
                    "$set": {
                        "current_command_id": command["command_id"],
                        "current_wire_command_id": wire_command_id,
                        "dispatch_state": "dispatched",
                        "updated_at": now,
                    }
                },
            )
            return

        await database[cls.RUN_COLLECTION].update_one(
            {
                "flow_task_id": run["flow_task_id"],
                "status": {"$in": ["pending", "waiting_for_selection", "running"]},
                "user_id": run["user_id"],
            },
            {
                "$set": {
                    "current_command_id": command["command_id"],
                    "current_wire_command_id": wire_command_id,
                    "dispatch_state": "dispatched",
                    "status": "running",
                    "updated_at": now,
                }
            },
        )

    @classmethod
    async def _finish_claim(
        cls,
        database: Any,
        command: dict[str, Any],
        *,
        error: Exception | None = None,
    ) -> None:
        selector = {"_id": command["_id"], "lease_token": command["lease_token"]}
        now = cls._now()
        if error is None:
            await database[cls.COMMAND_COLLECTION].update_one(
                selector,
                {
                    "$set": {
                        "expires_at": now
                        + timedelta(days=get_settings().workflow_command_retention_days),
                        "status": "dispatched",
                        "updated_at": now,
                    },
                    "$unset": {"last_error": "", "lease_expires_at": "", "lease_token": ""},
                },
            )
            return

        attempts = int(command.get("attempts") or 1)
        retry_delay = min(60, 2 ** min(attempts, 6))
        error_message = f"{type(error).__name__}: {error}"[:1000]
        await database[cls.COMMAND_COLLECTION].update_one(
            selector,
            {
                "$set": {
                    "last_error": error_message,
                    "next_attempt_at": now + timedelta(seconds=retry_delay),
                    "status": "pending",
                    "updated_at": now,
                },
                "$unset": {"expires_at": "", "lease_expires_at": "", "lease_token": ""},
            },
        )
        await database[cls.RUN_COLLECTION].update_one(
            {"flow_task_id": command["flow_task_id"], "status": {"$ne": "cancelled"}},
            {
                "$set": {
                    "dispatch_state": "pending_retry",
                    "last_dispatch_error": error_message,
                    "updated_at": now,
                }
            },
        )

    @classmethod
    async def dispatch_command(
        cls,
        *,
        database: Any,
        redis_client: Any,
        user_id: str | None = None,
        command_id: str | None = None,
    ) -> bool:
        command = await cls._claim_command(database, user_id=user_id, command_id=command_id)
        if command is None:
            return False

        try:
            await cls._dispatch_claimed(database, redis_client, command)
        except Exception as exc:
            logger.exception(
                "workflow v2 dispatch failed command_id=%s flow_task_id=%s",
                command.get("command_id"),
                command.get("flow_task_id"),
            )
            await cls._finish_claim(database, command, error=exc)
            return False

        await cls._finish_claim(database, command)
        return True

    @classmethod
    async def dispatch_due_commands(
        cls,
        *,
        database: Any,
        redis_client: Any,
        limit: int = 50,
    ) -> int:
        dispatched = 0
        for _ in range(limit):
            command = await cls._claim_command(database)
            if command is None:
                break
            try:
                await cls._dispatch_claimed(database, redis_client, command)
            except Exception as exc:
                logger.exception(
                    "workflow v2 dispatch failed command_id=%s flow_task_id=%s",
                    command.get("command_id"),
                    command.get("flow_task_id"),
                )
                await cls._finish_claim(database, command, error=exc)
                continue
            await cls._finish_claim(database, command)
            dispatched += 1
        return dispatched


async def workflow_command_dispatcher_forever(database: Any, redis_client: Any) -> None:
    while True:
        try:
            await WorkflowRunV2Service.dispatch_due_commands(
                database=database,
                redis_client=redis_client,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("workflow v2 command dispatcher failed")
        await asyncio.sleep(get_settings().workflow_command_dispatch_interval_seconds)
