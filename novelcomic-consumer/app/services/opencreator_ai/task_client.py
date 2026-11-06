"""Client for submitting model work to the NovelComic Agent service."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from app.services.opencreator_ai.schemas import CreateTaskRequest, CreateTaskResponse


class OpenCreatorAISubmitError(Exception):
    """Raised when the AI task service cannot accept a model task."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


@dataclass(frozen=True)
class OpenCreatorAITaskData:
    ai_task_id: str
    status: str
    existing: bool = False


class OpenCreatorAITaskClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float = 30.0,
        auth_key: str | None = None,
    ) -> None:
        self.submit_url = f"{base_url.rstrip('/')}/v1/tasks"
        self.timeout_seconds = timeout_seconds
        self.auth_key = auth_key

    async def create_task(
        self, request: CreateTaskRequest | dict[str, Any]
    ) -> OpenCreatorAITaskData:
        body = (
            request.model_dump(exclude_none=True)
            if isinstance(request, CreateTaskRequest)
            else request
        )
        try:
            status_code, payload = await asyncio.to_thread(self._post_json, body)
        except TimeoutError as exc:
            raise OpenCreatorAISubmitError("AI task submit request timed out") from exc
        except urllib.error.HTTPError as exc:
            response_body = self._read_error_body(exc)
            raise OpenCreatorAISubmitError(
                "AI task submit request was rejected"
                if 400 <= exc.code < 500
                else "AI task service failed",
                status_code=exc.code,
                response_body=response_body,
            ) from exc
        except (OSError, urllib.error.URLError) as exc:
            raise OpenCreatorAISubmitError("AI task submit request failed") from exc
        except ValueError as exc:
            raise OpenCreatorAISubmitError("AI task submit response was invalid JSON") from exc

        if not isinstance(payload, dict):
            raise OpenCreatorAISubmitError("AI task submit response must be an object")
        if status_code not in {200, 202}:
            raise OpenCreatorAISubmitError(
                "AI task submit returned unexpected status",
                status_code=status_code,
                response_body=json.dumps(payload, ensure_ascii=False, default=str),
            )
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        try:
            response = CreateTaskResponse.model_validate(data)
        except ValidationError as exc:
            raise OpenCreatorAISubmitError("AI task submit response schema was invalid") from exc
        return OpenCreatorAITaskData(
            ai_task_id=response.ai_task_id,
            status=response.status,
            existing=response.existing or status_code == 200 or response.status == "existing",
        )

    async def submit(self, request: CreateTaskRequest | dict[str, Any]) -> OpenCreatorAITaskData:
        return await self.create_task(request)

    def _post_json(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        encoded = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.auth_key:
            headers["auth_key"] = self.auth_key
        request = urllib.request.Request(
            self.submit_url,
            data=encoded,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            response_body = response.read().decode("utf-8")
            status_code = response.status
        return status_code, json.loads(response_body)

    @staticmethod
    def _read_error_body(error: urllib.error.HTTPError) -> str | None:
        try:
            return error.read().decode("utf-8")
        except Exception:
            return None
