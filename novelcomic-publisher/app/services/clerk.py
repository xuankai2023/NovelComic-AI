"""身份平台 Clerk。只查用户、验密、建用户、开票，不编排登录。"""

import logging
from typing import Any

from clerk_backend_api import Clerk

from app.config import get_settings

log = logging.getLogger(__name__)


class ClerkService:
    """票的默认有效期是 30 天，和注册响应里的 expires_in 一致。"""

    SIGN_IN_TOKEN_TTL = 2_592_000

    @classmethod
    def _client(cls) -> Clerk:
        return Clerk(bearer_auth=get_settings().clerk_api_key)

    @classmethod
    async def get_user_by_email(cls, email: str) -> Any | None:
        """按邮箱查身份用户。没有这个邮箱时返回 None。"""
        try:
            async with cls._client() as clerk:
                result = await clerk.users.list_async(request={"email_address": [email]})
        except Exception as error:
            log.error("查询用户失败: email=%s, error=%s", email, error)
            raise
        if not result:
            log.warning("用户不存在: email=%s", email)
            return None
        user = result[0]
        log.info("找到用户: email=%s, user_id=%s", email, user.id)
        return user

    @classmethod
    async def verify_user_password(cls, user_id: str, password: str) -> bool:
        """密码正确返回 True。密码错误返回 False。接口本身失败时抛出异常。"""
        try:
            async with cls._client() as clerk:
                await clerk.users.verify_password_async(user_id=user_id, password=password)
        except Exception as error:
            log.warning("密码验证失败: user_id=%s, error=%s", user_id, error)
            return False
        log.info("密码验证成功: user_id=%s", user_id)
        return True

    @classmethod
    async def create_user_with_email(
        cls,
        email: str,
        skip_password: bool = True,
        unsafe_metadata: dict[str, Any] | None = None,
    ) -> Any:
        """用邮箱创建身份用户。默认不要求密码，邮箱视为已验证。"""
        request: dict[str, Any] = {
            "email_address": [email],
            "skip_password_requirement": skip_password,
        }
        if unsafe_metadata:
            request["unsafe_metadata"] = unsafe_metadata
        try:
            async with cls._client() as clerk:
                user = await clerk.users.create_async(request=request)
        except Exception as error:
            log.error("Clerk 用户创建失败: email=%s, error=%s", email, error)
            raise
        log.info("Clerk 用户创建成功: email=%s, user_id=%s", email, user.id)
        return user

    @classmethod
    async def create_sign_in_token(
        cls,
        user_id: str,
        expires_in_seconds: int = SIGN_IN_TOKEN_TTL,
    ) -> str:
        """创建换 Session 的票。登录放进 ticket，注册放进 sign_in_token。"""
        try:
            async with cls._client() as clerk:
                sign_in_token = await clerk.sign_in_tokens.create_async(
                    request={
                        "user_id": user_id,
                        "expires_in_seconds": expires_in_seconds,
                    }
                )
        except Exception as error:
            log.error("创建 Sign-in Token 失败: user_id=%s, error=%s", user_id, error)
            raise
        log.info("创建 Sign-in Token 成功: user_id=%s", user_id)
        return sign_in_token.token

    @classmethod
    async def update_user_password(cls, user_id: str, password: str) -> bool:
        """改密成功后写入新密码。"""
        try:
            async with cls._client() as clerk:
                await clerk.users.update_async(
                    user_id=user_id,
                    password=password,
                    skip_password_checks=True,
                )
        except Exception as error:
            log.error("密码更新失败: user_id=%s, error=%s", user_id, error)
            raise
        log.info("密码更新成功: user_id=%s", user_id)
        return True
