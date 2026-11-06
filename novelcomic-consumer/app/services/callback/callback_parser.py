"""Normalize and validate AI gateway callback payloads across vendors."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AiTaskCallbackError(BaseModel):
    model_config = ConfigDict(extra="allow")

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    retryable: bool | None = None
    details: dict[str, Any] | list[Any] | str | int | float | bool | None = None


class AiTaskPublicCallbackPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    ai_task_id: str = Field(min_length=1)
    status: str = Field(pattern="^(success|succeeded|completed|failed|timed_out|timeout|cancelled)$")
    model_id: str = Field(min_length=1)
    trace_id: str | None = Field(default=None, min_length=1)
    provider: str | None = Field(default=None, min_length=1)
    provider_model_id: str | None = Field(default=None, min_length=1)
    provider_request_id: str | None = Field(default=None, min_length=1)
    display_group: str | None = None
    error_code: str | int | None = None
    provider_telemetry: dict[str, Any] | None = None
    client_context: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    usage: dict[str, Any] | None = None
    error: AiTaskCallbackError | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass(frozen=True)
class ParsedCallbackEnvelope:
    vendor: str
    external_task_id: str
    status: str
    model_id: str
    trace_id: str | None
    result: dict[str, Any]
    error: dict[str, Any]
    usage: dict[str, Any]
    client_context: dict[str, Any]
    raw_payload: dict[str, Any]


class CallbackParser:
    @staticmethod
    def normalize_status(raw_status: str) -> str:
        normalized = str(raw_status or "").strip().lower()
        if normalized in {"success", "succeeded", "completed"}:
            return "success"
        if normalized in {"timeout", "timed_out"}:
            return "timeout"
        return "failed"

    @classmethod
    def parse(cls, vendor: str, payload: dict[str, Any]) -> ParsedCallbackEnvelope:
        validated = AiTaskPublicCallbackPayload.model_validate(payload)
        dumped = validated.model_dump(mode="json", exclude_none=True)
        status = cls.normalize_status(validated.status)
        result = dumped.get("result") if isinstance(dumped.get("result"), dict) else {}
        error = dumped.get("error") if isinstance(dumped.get("error"), dict) else {}
        if status != "success" and not error:
            error = {
                "code": str(dumped.get("error_code") or ("timed_out" if status == "timeout" else "callback_failed")),
                "message": "AI task timed out" if status == "timeout" else "AI task failed",
            }
        return ParsedCallbackEnvelope(
            vendor=vendor,
            external_task_id=validated.ai_task_id,
            status=status,
            model_id=validated.model_id,
            trace_id=validated.trace_id,
            result=result,
            error={} if status == "success" else error,
            usage=dumped.get("usage") if isinstance(dumped.get("usage"), dict) else {},
            client_context=dumped.get("client_context") if isinstance(dumped.get("client_context"), dict) else {},
            raw_payload=dumped,
        )
