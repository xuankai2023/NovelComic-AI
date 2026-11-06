"""Publisher Sentry 采样和积分不足过滤。没有 DSN 就不初始化。"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

EXPECTED_EXCEPTION_TYPES = frozenset({"InsufficientCredits"})

SENSITIVE_KEYS = frozenset(
    {
        "prompt",
        "image_urls",
        "img_url",
        "api_key",
        "token",
        "password",
        "secret",
        "authorization",
    }
)


def _scrub_data(data: Any) -> Any:
    if isinstance(data, dict):
        return {
            key: "[FILTERED]"
            if isinstance(key, str) and key.lower() in SENSITIVE_KEYS
            else _scrub_data(value)
            for key, value in data.items()
        }
    if isinstance(data, list):
        return [_scrub_data(item) for item in data]
    if isinstance(data, tuple):
        return tuple(_scrub_data(item) for item in data)
    return data


def before_send(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any] | None:
    exc_info = hint.get("exc_info")
    if exc_info:
        exc_type = exc_info[0]
        if exc_type and exc_type.__name__ in EXPECTED_EXCEPTION_TYPES:
            return None
    if "extra" in event:
        event["extra"] = _scrub_data(event["extra"])
    breadcrumbs = event.get("breadcrumbs") or {}
    for crumb in breadcrumbs.get("values") or []:
        if "data" in crumb:
            crumb["data"] = _scrub_data(crumb["data"])
    return event


def before_send_transaction(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any] | None:
    del hint
    if event.get("transaction") in {"/health", "/readyz"}:
        return None
    return event


def traces_sampler(sampling_context: dict[str, Any]) -> float:
    name = str((sampling_context.get("transaction_context") or {}).get("name") or "")
    if name in {"/health", "/readyz"}:
        return 0
    if "mq_callback" in name:
        return 0.05
    return 0.2


def init_sentry(dsn: str | None, environment: str | None) -> None:
    if not dsn:
        logger.warning("Sentry DSN not configured, skipping Sentry init")
        return
    try:
        import sentry_sdk
    except Exception:
        logger.warning("sentry_sdk is not installed, skipping Sentry init")
        return
    integrations: list[Any] = []
    try:
        from sentry_sdk.integrations.fastapi import FastApiIntegration

        integrations.append(FastApiIntegration(transaction_style="endpoint"))
    except Exception:
        pass

    sentry_sdk.init(
        dsn=dsn,
        environment=environment or "local",
        server_name="publisher",
        traces_sampler=traces_sampler,
        profiles_sample_rate=0.1,
        send_default_pii=False,
        integrations=integrations,
        before_send=before_send,
        before_send_transaction=before_send_transaction,
    )
    logger.info("Sentry initialized for publisher, environment=%s", environment or "local")
