"""Bounded retry decisions from the implementation plan."""

from dataclasses import dataclass
from typing import Literal

RetryCategory = Literal[
    "deterministic-local",
    "provider-timeout",
    "image-quality",
    "tts-primary",
    "tts-fallback",
    "lambda-render",
]
RetryAction = Literal[
    "retry",
    "fallback-provider",
    "downgrade",
    "reconcile-provider",
    "stop",
]


@dataclass(frozen=True, slots=True)
class RetryContext:
    category: RetryCategory
    attempt: int
    retryable: bool
    cancelled: bool
    budget_available: bool
    provider_reconciled: bool = False


@dataclass(frozen=True, slots=True)
class RetryDecision:
    action: RetryAction
    max_attempts: int | None = None
    reason: str | None = None


def decide_retry(context: RetryContext) -> RetryDecision:
    if context.cancelled:
        return RetryDecision("stop", reason="production cancelled")
    if not context.budget_available:
        return RetryDecision("stop", reason="budget unavailable")
    if not context.retryable:
        return RetryDecision("stop", reason="error is not retryable")

    if context.category == "deterministic-local":
        return _under_limit(context.attempt, 3)
    if context.category == "provider-timeout":
        if not context.provider_reconciled:
            return RetryDecision("reconcile-provider")
        return _under_limit(context.attempt, 2)
    if context.category == "image-quality":
        if context.attempt < 1:
            return RetryDecision("retry", max_attempts=1)
        return RetryDecision("downgrade")
    if context.category == "tts-primary":
        if context.attempt < 1:
            return RetryDecision("retry", max_attempts=1)
        return RetryDecision("fallback-provider")
    if context.category == "tts-fallback":
        return RetryDecision("stop", reason="fallback provider failed")
    return RetryDecision("retry", max_attempts=3)


def _under_limit(attempt: int, max_attempts: int) -> RetryDecision:
    if attempt < max_attempts:
        return RetryDecision("retry", max_attempts=max_attempts)
    return RetryDecision("stop", reason="retry limit reached")
