import os
from functools import lru_cache
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_QUEUE_DEFAULTS = {
    "run_flow_queue_name": "run_flow",
    "flow_resume_queue_name": "flow_resume",
    "flow_maintenance_queue_name": "flow_maintenance",
}


def resolve_settings_env_file(app_env: str | None = None) -> str:
    """Pick the env file from the process environment, before that file is loaded."""

    if app_env is None:
        app_env = os.environ.get("APP_ENV", "")
    selected = app_env.strip()
    if not selected:
        return ".env.local"
    return f".env.{selected}"


def v2_result_queue_name(app_env: str, override: str | None = None) -> str:
    explicit = (override or "").strip()
    if explicit:
        return explicit
    env_name = app_env.strip() or "local"
    return f"flow_result.workflow.v2.{env_name}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "novelcomic-consumer"
    app_env: str = "local"
    run_flow_queue_name: str = "run_flow"
    flow_v2_result_queue_name: str = ""
    sentry_dsn: str = ""
    sentry_environment: str = "local"
    host: str = "0.0.0.0"
    port: int = 8001
    cors_origins: str = "http://localhost:3000"
    mongo_url: str = Field(default="mongodb://localhost:27017", validation_alias="MONGO_URL")
    mongo_database: str = "novelcomic"
    redis_url: str = "redis://localhost:6379/0"
    rabbitmq_url: str = "amqp://novelcomic:novelcomic@localhost:5672/"
    dependency_timeout_seconds: float = 3.0
    oc_api_url: str = "http://localhost:18791"
    oc_auth_key: str = ""
    opencreator_ai_auth_key: str = ""
    ai_submit_timeout_seconds: float = 30.0
    consumer_public_base_url: str = "http://localhost:8001"
    consumer_webhook_secret: str = Field(
        default="",
        description="密钥为空则跳过验签；配了密钥才核对 x-oc-timestamp 和 x-oc-signature。",
    )
    consumer_webhook_timestamp_tolerance_seconds: int = 300
    internal_api_key: str = ""
    feishu_consumer_webhook_url: str = Field(default="", validation_alias="FEISHU_CONSUMER_WEBHOOK_URL")
    feishu_notify_timeout_seconds: float = 5.0
    b2b_feishu_webhook_url: str = Field(default="", validation_alias="B2B_FEISHU_WEBHOOK_URL")
    b2b_feishu_timeout_seconds: float = Field(default=5.0, validation_alias="B2B_FEISHU_TIMEOUT_SECONDS")
    flow_command_inbox_lease_seconds: int = 300
    flow_command_inbox_redelivery_lease_seconds: int = 30
    flow_command_inbox_failed_retry_delay_seconds: int = 5
    flow_command_inbox_retention_seconds: int = 60 * 60 * 24 * 7
    flow_command_inbox_sweep_interval_seconds: int = 10
    flow_command_inbox_redelivery_limit: int = 50
    webhook_callback_timeout_seconds: int = 1800
    flow_running_node_orphan_seconds: int = 300
    flow_terminal_event_reconcile_limit: int = 100
    pending_deduction_reconcile_limit: int = 100
    flow_event_outbox_replay_limit: int = 100
    flow_resume_queue_name: str = "flow_resume"
    flow_maintenance_queue_name: str = "flow_maintenance"
    flow_maintenance_scheduler_enabled: bool = True
    flow_maintenance_interval_seconds: int = 60
    flow_recover_running_interval_seconds: int = 300
    flow_start_lock_ttl_seconds: int = 300
    flow_resume_lock_ttl_seconds: int = 300
    flow_event_outbox_publish_lease_seconds: int = 30
    flow_event_outbox_retry_delay_seconds: int = 5
    flow_event_outbox_retention_seconds: int = 60 * 60 * 24 * 7
    consumer_instance_id: str = Field(
        default_factory=lambda: os.getenv("CONSUMER_INSTANCE_ID", str(os.getpid()))
    )
    readyz_max_flow_resume_backlog: int = 0
    readyz_max_stale_webhook_invocations: int = 0

    def __init__(self, **values: Any) -> None:
        env_file = values.pop("_env_file", None)
        if env_file is None:
            env_file = resolve_settings_env_file()
        super().__init__(_env_file=env_file, **values)

    @field_validator("app_env", mode="before")
    @classmethod
    def _normalize_app_env(cls, value: object) -> object:
        if value is None:
            return "local"
        if isinstance(value, str):
            return value.strip() or "local"
        return value

    @field_validator("flow_v2_result_queue_name", mode="before")
    @classmethod
    def _normalize_v2_queue_override(cls, value: object) -> object:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator(
        "run_flow_queue_name",
        "flow_resume_queue_name",
        "flow_maintenance_queue_name",
        mode="before",
    )
    @classmethod
    def _normalize_queue_name(cls, value: object, info: Any) -> object:
        fallback = _QUEUE_DEFAULTS[info.field_name]
        if value is None:
            return fallback
        if isinstance(value, str):
            return value.strip() or fallback
        return value

    @field_validator("consumer_instance_id", mode="before")
    @classmethod
    def _normalize_consumer_instance_id(cls, value: object) -> object:
        if value is None:
            return str(os.getpid())
        if isinstance(value, str):
            return value.strip() or str(os.getpid())
        return value

    @property
    def v2_reply_queue(self) -> str:
        return v2_result_queue_name(self.app_env, self.flow_v2_result_queue_name)


@lru_cache
def get_settings() -> Settings:
    return Settings()
