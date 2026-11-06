"""Structured comic control-plane errors."""

from typing import Any, Literal

from .base import ContractModel

ErrorCode = Literal[
    "INVALID_REQUEST",
    "IDEMPOTENCY_CONFLICT",
    "INVALID_STATE_TRANSITION",
    "STAGE_GUARD_REJECTED",
    "DRAFT_NOT_FOUND",
    "DRAFT_REVISION_CONFLICT",
    "COMPOSE_COMMAND_CONFLICT",
    "COMPOSE_FAILED",
    "BUDGET_EXCEEDED",
    "PRODUCTION_CANCELLED",
    "JOB_LEASE_CONFLICT",
    "PROVIDER_RECONCILIATION_REQUIRED",
]


class ServiceErrorBody(ContractModel):
    code: ErrorCode
    message: str
    retryable: bool
    details: dict[str, Any] | None = None


class ComicServiceError(Exception):
    """Exception carrying a stable API-facing code and retry decision."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        retryable: bool,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.body = ServiceErrorBody(
            code=code,
            message=message,
            retryable=retryable,
            details=details,
        )

    @property
    def code(self) -> ErrorCode:
        return self.body.code
