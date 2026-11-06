import os
import uuid
from functools import lru_cache
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def resolve_settings_env_file(app_env: str | None = None) -> str:
    """Pick the env file from the process environment, before that file is loaded."""

    if app_env is None:
        app_env = os.environ.get("APP_ENV", "")
    selected = app_env.strip()
    if not selected:
        return ".env.local"
    return f".env.{selected}"


def new_publisher_deploy_id() -> str:
    return f"pub-{uuid.uuid4().hex[:8]}"


def instance_reply_queue_name(deploy_id: str) -> str:
    slot = deploy_id.strip()
    if not slot:
        raise ValueError("publisher deploy id is empty")
    return f"flow_result.{slot}"


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

    app_name: str = "novelcomic-publisher"
    app_env: str = "local"
    publisher_deploy_id: str = Field(default_factory=new_publisher_deploy_id)
    flow_v2_result_queue_name: str = ""
    sentry_dsn: str = ""
    sentry_environment: str = "local"
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:3000"
    mongo_url: str = Field(default="mongodb://localhost:27017", validation_alias="MONGO_URL")
    mongo_database: str = "novelcomic"
    redis_url: str = "redis://localhost:6379/0"
    rabbitmq_url: str = "amqp://novelcomic:novelcomic@localhost:5672/"
    dependency_timeout_seconds: float = 3.0
    cos_bucket: str = ""
    cos_region: str = ""
    cos_secret_id: str = ""
    cos_secret_key: str = ""
    cos_cdn_domain: str = ""
    cos_accelerate_domain: str = ""
    s3_domain: str = ""
    cloud_front_domain: str = ""
    ai_api_base_url: str = ""
    byteplus_create_asset_url: str = ""
    byteplus_api_key: str = ""
    clerk_api_key: str = ""
    clerk_pem_public_key: str = ""
    clerk_webhook_secret: str = ""
    stripe_secret_key: str = Field(default="", validation_alias="STRIPE_SECRET_KEY")
    stripe_webhook_secret: str = Field(default="", validation_alias="STRIPE_WEBHOOK_SECRET")
    tiktok_client_key: str = Field(default="", validation_alias="TIKTOK_CLIENT_KEY")
    tiktok_client_secret: str = Field(default="", validation_alias="TIKTOK_CLIENT_SECRET")
    google_client_id: str = Field(default="", validation_alias="GOOGLE_CLIENT_ID")
    google_client_secret: str = Field(default="", validation_alias="GOOGLE_CLIENT_SECRET")
    x_client_id: str = Field(default="", validation_alias="X_CLIENT_ID")
    x_client_secret: str = Field(default="", validation_alias="X_CLIENT_SECRET")
    feishu_encrypt_key: str = Field(default="", validation_alias="FEISHU_ENCRYPT_KEY")
    feishu_verification_token: str = Field(
        default="",
        validation_alias="FEISHU_VERIFICATION_TOKEN",
    )
    feishu_bot_webhook: str = Field(default="", validation_alias="FEISHU_BOT_WEBHOOK")
    b2b_feishu_webhook_url: str = Field(default="", validation_alias="B2B_FEISHU_WEBHOOK_URL")
    b2b_feishu_timeout_seconds: float = Field(
        default=5.0,
        validation_alias="B2B_FEISHU_TIMEOUT_SECONDS",
    )
    lark_custom_order_webhook_url: str = Field(
        default="",
        validation_alias="LARK_CUSTOM_ORDER_WEBHOOK_URL",
    )
    lark_custom_order_timeout_seconds: float = Field(
        default=5.0,
        validation_alias="LARK_CUSTOM_ORDER_TIMEOUT_SECONDS",
    )
    feishu_max_credits_per_operation: int = Field(
        default=1_000_000,
        validation_alias="FEISHU_MAX_CREDITS_PER_OPERATION",
    )
    aliyun_dm_access_key_id: str = ""
    aliyun_dm_access_key_secret: str = ""
    aliyun_dm_region: str = "cn-hangzhou"
    aliyun_dm_account_name: str = ""
    aliyun_dm_from_alias: str = "NovelComic"
    aliyun_viapi_access_key_id: str = ""
    aliyun_viapi_access_key_secret: str = ""
    aliyun_imageseg_endpoint: str = "imageseg.cn-shanghai.aliyuncs.com"
    image_segmentation_credit_balance: int | None = None
    workflow_command_dispatch_interval_seconds: float = 2.0
    workflow_command_dispatch_lease_seconds: int = 30
    workflow_command_retention_days: int = 7
    workflow_event_stream_ttl_seconds: int = 24 * 60 * 60
    workflow_event_stream_maxlen: int = 10_000
    internal_api_key: str = ""
    consumer_blue_url: str = ""
    consumer_green_url: str = ""

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

    @field_validator("publisher_deploy_id", mode="before")
    @classmethod
    def _normalize_publisher_deploy_id(cls, value: object) -> object:
        if value is None:
            return new_publisher_deploy_id()
        if isinstance(value, str):
            return value.strip() or new_publisher_deploy_id()
        return value

    @field_validator("flow_v2_result_queue_name", mode="before")
    @classmethod
    def _normalize_v2_queue_override(cls, value: object) -> object:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        return value

    @property
    def instance_reply_queue(self) -> str:
        return instance_reply_queue_name(self.publisher_deploy_id)

    @property
    def v2_reply_queue(self) -> str:
        return v2_result_queue_name(self.app_env, self.flow_v2_result_queue_name)


@lru_cache
def get_settings() -> Settings:
    return Settings()
