"""验证码和发送冷却。只跟 Redis 说话，不编排登录。"""

import json
import logging
from typing import Literal, TypedDict

import redis.asyncio as redis

from app.config import get_settings

log = logging.getLogger(__name__)


class CodeData(TypedDict):
    code: str
    code_type: Literal["login", "register"]
    fp_hash: str
    fp_time: str
    created_at: int


class RedisService:
    """验证码有效 5 分钟，同一邮箱 60 秒内只能发一次。"""

    CODE_TTL = 300
    RATE_LIMIT_TTL = 60
    CODE_DATA_KEY_PREFIX = "novelcomic:auth:code_data"
    RATE_LIMIT_KEY_PREFIX = "novelcomic:auth:rate_limit"

    _client: redis.Redis | None = None

    @classmethod
    def _redis(cls) -> redis.Redis:
        if cls._client is None:
            cls._client = redis.from_url(get_settings().redis_url, decode_responses=True)
        return cls._client

    @classmethod
    def _code_key(cls, email: str) -> str:
        return f"{cls.CODE_DATA_KEY_PREFIX}:{email}"

    @classmethod
    def _rate_limit_key(cls, email: str) -> str:
        return f"{cls.RATE_LIMIT_KEY_PREFIX}:{email}"

    @classmethod
    async def check_rate_limit(cls, email: str) -> bool:
        """仍在冷却期时返回 True，这时不能再发验证码。"""
        key = cls._rate_limit_key(email)
        if await cls._redis().exists(key):
            ttl = await cls._redis().ttl(key)
            log.warning("发送频率限制: email=%s, 剩余 %s 秒", email, ttl)
            return True
        return False

    @classmethod
    async def set_rate_limit(cls, email: str) -> None:
        """验证码发出去之后写入冷却标记。"""
        await cls._redis().set(cls._rate_limit_key(email), "1", ex=cls.RATE_LIMIT_TTL)
        log.info("已设置发送频率限制: email=%s, ttl=%s秒", email, cls.RATE_LIMIT_TTL)

    @classmethod
    async def get_rate_limit_ttl(cls, email: str) -> int:
        """剩余冷却秒数。没有限制时返回 0。"""
        ttl = await cls._redis().ttl(cls._rate_limit_key(email))
        if ttl < 0:
            return 0
        return ttl

    @classmethod
    async def store_code_data(cls, email: str, data: CodeData) -> None:
        """保存验证码、code_type、设备指纹、时区和创建时间。"""
        await cls._redis().set(
            cls._code_key(email),
            json.dumps(data),
            ex=cls.CODE_TTL,
        )
        log.info(
            "验证码数据已存储: email=%s, code_type=%s, ttl=%s秒",
            email,
            data.get("code_type"),
            cls.CODE_TTL,
        )

    @classmethod
    async def get_code_data(cls, email: str) -> CodeData | None:
        """读取验证码数据。不存在或已过期时返回 None。"""
        raw = await cls._redis().get(cls._code_key(email))
        if raw is None:
            log.warning("验证码数据不存在或已过期: email=%s", email)
            return None
        log.info("从 Redis 读取验证码数据: email=%s", email)
        return json.loads(raw)

    @classmethod
    async def delete_code_data(cls, email: str) -> None:
        """验证通过后删掉，避免同一条验证码再用一次。"""
        deleted = await cls._redis().delete(cls._code_key(email))
        if deleted:
            log.info("验证码数据已删除: email=%s", email)
        else:
            log.warning("尝试删除不存在的验证码数据: email=%s", email)
