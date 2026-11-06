"""Sentry initialization and a span wrapper that never raises."""

from __future__ import annotations

from typing import Any

_initialized = False
_HEALTH_TRANSACTIONS = {"/health", "/readyz"}


class SafeSpan:
    """Sentry span that becomes a no-op when the SDK is missing or raises."""

    __slots__ = ("_span",)

    def __init__(self, op: str, name: str) -> None:
        try:
            import sentry_sdk

            self._span = sentry_sdk.start_span(op=op, name=name)
        except Exception:
            self._span = None

    def set_data(self, key: str, value: Any) -> None:
        try:
            if self._span:
                self._span.set_data(key, value)
        except Exception:
            return

    def set_status(self, status: str) -> None:
        try:
            if self._span:
                self._span.set_status(status)
        except Exception:
            return

    def __enter__(self) -> SafeSpan:
        try:
            if self._span:
                self._span.__enter__()
        except Exception:
            self._span = None
        return self

    def __exit__(self, *_exc_info: object) -> None:
        try:
            if self._span:
                self._span.__exit__(None, None, None)
        except Exception:
            return


class SafeTransaction(SafeSpan):
    """Root Sentry transaction that becomes a no-op when the SDK fails."""

    def __init__(self, op: str, name: str) -> None:
        try:
            import sentry_sdk

            self._span = sentry_sdk.start_transaction(op=op, name=name)
        except Exception:
            self._span = None


def traces_sampler(sampling_context: dict[str, Any]) -> float:
    """Sample every transaction except health checks."""

    transaction = sampling_context.get("transaction_context", {})
    name = transaction.get("name", "") if isinstance(transaction, dict) else ""
    if name in _HEALTH_TRANSACTIONS:
        return 0
    return 1.0


def before_send_transaction(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any] | None:
    """Drop health-check transactions before they leave the process."""

    if event.get("transaction") in _HEALTH_TRANSACTIONS:
        return None
    return event


def init_sentry(dsn: str, environment: str = "local") -> None:
    """Initialize Sentry. An empty DSN or an SDK error skips initialization."""

    global _initialized
    if _initialized or not dsn:
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            server_name="agent",
            traces_sampler=traces_sampler,
            before_send_transaction=before_send_transaction,
        )
        _initialized = True
    except Exception:
        return
