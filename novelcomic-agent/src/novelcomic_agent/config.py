"""Application configuration."""

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def agent_reply_queue_name(deploy_id: str) -> str:
    slot = deploy_id.strip()
    if not slot:
        raise ValueError("workflow deploy id is empty")
    return f"flow_result.{slot}"


class Settings(BaseSettings):
    """Settings loaded from environment variables and ``.env.local``."""

    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "novelcomic-agent"
    app_host: str = "0.0.0.0"
    app_port: int = 18791
    app_log_level: str = "info"
    cors_origins: str = "http://localhost:3000"

    mongodb_uri: str = "mongodb://127.0.0.1:27017"
    mongodb_database: str = "novelcomic"
    redis_url: str = "redis://127.0.0.1:6379/0"
    rabbitmq_url: str = "amqp://novelcomic:novelcomic@127.0.0.1:5672/"
    comic_database_url: str = (
        "postgresql://postgres:postgres@127.0.0.1:5432/novelcomic"
    )
    cos_secret_id: str = ""
    cos_secret_key: str = ""
    cos_region: str = ""
    cos_bucket: str = ""
    cos_cdn_domain: str = ""
    comic_allowed_hosts: str = ""
    comic_ocr_endpoint: str = ""
    comic_ocr_api_key: str = ""
    comic_tts_endpoint: str = ""
    comic_tts_api_key: str = ""
    comic_tts_voice_id: str = ""
    comic_tts_unit_price_fen: int = Field(default=0, ge=0)
    comic_layer_unit_price_fen: int = Field(default=0, ge=0)
    comic_sprite_unit_price_fen: int = Field(default=0, ge=0)
    aliyun_viapi_access_key_id: str = ""
    aliyun_viapi_access_key_secret: str = ""
    aliyun_imageseg_endpoint: str = "imageseg.cn-shanghai.aliyuncs.com"
    remotion_compose_base_url: str = "http://127.0.0.1:3000"
    dependency_timeout_seconds: float = Field(default=3.0, gt=0)
    sentry_dsn: str = ""
    sentry_environment: str = "local"
    posthog_api_key: str = ""
    posthog_enabled: bool = False
    posthog_host: str = "https://us.i.posthog.com"
    clerk_pem_public_key: str = ""
    public_chat_user_id: str = ""
    memory_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "memory_enabled",
            "MEMORY_ENABLED",
            "CREATO_MEMORY__ENABLED",
        ),
    )
    workflow_deploy_id: str = Field(
        default="",
        validation_alias=AliasChoices("WORKFLOW_DEPLOY_ID", "CREATO_WORKFLOW__DEPLOY_ID"),
    )

    @property
    def reply_queue_name(self) -> str:
        slot = self.workflow_deploy_id.strip()
        if not slot:
            return ""
        return agent_reply_queue_name(slot)


def public_switch_dump(settings: Settings) -> dict[str, bool]:
    """未启用开关只写出开或关，密钥留在 Settings 里。"""

    return {
        "memory_enabled": settings.memory_enabled,
        "posthog_enabled": settings.posthog_enabled,
    }


@lru_cache
def get_settings() -> Settings:
    """Return one immutable-by-convention settings instance per process."""

    return Settings()
