"""登录编排层。把 Redis 验证码和 Clerk 身份操作串起来。"""

import logging
import random
import time
from typing import Any

from app.services.clerk import ClerkService
from app.services.email_service import EmailService
from app.services.redis_service import RedisService

log = logging.getLogger(__name__)


class RateLimitError(Exception):
    """验证码发送过于频繁。"""


class EmailSendError(Exception):
    """验证码发送失败。"""


class InvalidCodeError(Exception):
    """验证码不存在、过期、错误或用途不匹配。"""


class UserNotFoundError(Exception):
    """Clerk 中找不到用户。"""


class InvalidPasswordError(Exception):
    """密码不正确。"""


def _user_id(user: Any) -> str:
    user_id = getattr(user, "id", None)
    if not user_id:
        raise UserNotFoundError("用户不存在")
    return str(user_id)


class AuthService:
    @classmethod
    async def send_verification_code(
        cls,
        email: str,
        fp_hash: str,
        fp_time: str,
    ) -> dict[str, Any]:
        if await RedisService.check_rate_limit(email):
            ttl = await RedisService.get_rate_limit_ttl(email)
            raise RateLimitError(f"请 {ttl} 秒后再试")

        user = await ClerkService.get_user_by_email(email)
        code_type = "login" if user else "register"
        code = f"{random.randint(100000, 999999):06d}"
        await RedisService.store_code_data(
            email,
            {
                "code": code,
                "code_type": code_type,
                "created_at": int(time.time()),
                "fp_hash": fp_hash,
                "fp_time": fp_time,
            },
        )
        try:
            sent = await EmailService.send_verification_code(
                email=email,
                code=code,
                code_type=code_type,
            )
            if not sent:
                raise EmailSendError("邮件发送失败")
        except EmailSendError:
            await RedisService.delete_code_data(email)
            raise
        except Exception as error:
            await RedisService.delete_code_data(email)
            raise EmailSendError("邮件发送失败") from error

        await RedisService.set_rate_limit(email)
        log.info("验证码已生成并发送: email=%s, code_type=%s", email, code_type)
        return {"email": email, "code_type": code_type, "expires_in": RedisService.CODE_TTL}

    @classmethod
    async def verify_code_and_login(cls, email: str, code: str) -> dict[str, Any]:
        code_data = await RedisService.get_code_data(email)
        if not code_data or code_data["code"] != code:
            raise InvalidCodeError("验证码错误或已过期")
        if code_data["code_type"] != "login":
            raise InvalidCodeError("该验证码仅用于注册,请使用注册接口")

        user = await ClerkService.get_user_by_email(email)
        if user is None:
            await RedisService.delete_code_data(email)
            raise UserNotFoundError("该邮箱尚未注册")

        user_id = _user_id(user)
        ticket = await ClerkService.create_sign_in_token(user_id)
        await RedisService.delete_code_data(email)
        return {"ticket": ticket, "user_id": user_id}

    @classmethod
    async def register_with_code(
        cls,
        email: str,
        code: str,
        client_ip: str | None,
        source: str | None,
        invite_code: str | None,
    ) -> dict[str, Any]:
        code_data = await RedisService.get_code_data(email)
        if not code_data or code_data["code"] != code:
            raise InvalidCodeError("验证码错误或已过期")
        if code_data["code_type"] != "register":
            raise InvalidCodeError("该验证码仅用于登录,请使用登录接口")

        existing = await ClerkService.get_user_by_email(email)
        if existing is not None:
            await RedisService.delete_code_data(email)
            raise InvalidCodeError("该邮箱已注册,请直接登录")

        normalized_source = (
            source if source in {"direct", "template", "shared_template"} else (source or "direct")
        )
        user = await ClerkService.create_user_with_email(
            email,
            unsafe_metadata={
                "client_ip": client_ip,
                "invite_code": invite_code,
                "inviteCode": invite_code,
                "source": normalized_source,
                "fpHash": code_data.get("fp_hash", ""),
                "fpTime": code_data.get("fp_time", ""),
            },
        )
        user_id = _user_id(user)
        sign_in_token = await ClerkService.create_sign_in_token(user_id)
        await RedisService.delete_code_data(email)
        return {
            "expires_in": ClerkService.SIGN_IN_TOKEN_TTL,
            "sign_in_token": sign_in_token,
            "user_id": user_id,
        }

    @classmethod
    async def login_with_password(cls, email: str, password: str) -> dict[str, Any]:
        user = await ClerkService.get_user_by_email(email)
        if user is None:
            raise UserNotFoundError("用户不存在")

        user_id = _user_id(user)
        if not await ClerkService.verify_user_password(user_id, password):
            raise InvalidPasswordError("邮箱或密码错误")

        ticket = await ClerkService.create_sign_in_token(user_id)
        return {"ticket": ticket, "user_id": user_id}

    @classmethod
    async def change_password(cls, user_id: str, old_password: str, new_password: str) -> None:
        if old_password and not await ClerkService.verify_user_password(user_id, old_password):
            raise InvalidPasswordError("旧密码错误")
        await ClerkService.update_user_password(user_id, new_password)
