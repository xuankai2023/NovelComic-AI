"""OpenCreator AI model gateway provider."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from app.config import get_settings
from app.services.opencreator_ai.model_mapper import OpenCreatorAIModelMapper
from app.services.opencreator_ai.options_builder import OpenCreatorAIOptionsBuilder
from app.services.opencreator_ai.schemas import OpenCreatorAITaskRequest
from app.services.opencreator_ai.task_client import OpenCreatorAITaskClient


@dataclass(frozen=True)
class ModelProviderRequest:
    model_id: str
    webhook_url: str
    config_name: str = ""
    arguments: Mapping[str, Any] | None = None
    model_options: Mapping[str, Any] | None = None
    trace_id: str | None = None
    idempotency_key: str | None = None
    locale: Literal["zh", "en"] | None = None
    client_context: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ModelProviderSubmitResult:
    external_task_id: str
    status: str
    existing: bool
    model_id: str
    options: dict[str, Any] = field(default_factory=dict)


class OpenCreatorAIProvider:
    def __init__(self, task_client: OpenCreatorAITaskClient) -> None:
        self.task_client = task_client

    async def submit(self, request: ModelProviderRequest) -> ModelProviderSubmitResult:
        settings = get_settings()
        auth_key = (settings.oc_auth_key or settings.opencreator_ai_auth_key).strip()
        if not auth_key:
            raise ValueError(
                "OC_AUTH_KEY (or OPENCREATOR_AI_AUTH_KEY) is required for opencreator-ai submit; "
                "set it in the runtime environment (e.g. .env.local on the deploy host)"
            )

        opencreator_model_id = OpenCreatorAIModelMapper.to_opencreator_model_id(
            request.model_id,
            request.config_name,
        )
        mapped_request = replace(request, model_id=opencreator_model_id)
        options = OpenCreatorAIOptionsBuilder.build(mapped_request)
        task_request = OpenCreatorAITaskRequest(
            model_id=opencreator_model_id,
            options=options,
            webhook_url=request.webhook_url,
            trace_id=request.trace_id,
            idempotency_key=request.idempotency_key,
            locale=request.locale,
            client_context=dict(request.client_context or {}),
        )
        self.task_client.auth_key = auth_key
        task = await self.task_client.submit(task_request)
        return ModelProviderSubmitResult(
            external_task_id=task.ai_task_id,
            status=task.status,
            existing=task.existing,
            model_id=opencreator_model_id,
            options=options,
        )
