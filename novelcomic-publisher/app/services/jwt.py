"""用 Clerk PEM 公钥验业务 JWT，取出 sub 作为 user_id。"""

import logging

import jwt

from app.config import get_settings

log = logging.getLogger(__name__)


class JwtAuthenticationError(Exception):
    """签名无效、格式不对或已经过期。"""


class JwtExpiredTokenError(JwtAuthenticationError):
    """JWT 已过期。"""


class JwtInvalidTokenError(JwtAuthenticationError):
    """签名、格式或 sub 不合法。"""


class JwtService:
    @staticmethod
    async def get_payload_with_backoff(token: str) -> dict:
        """用 RS256 和 CLERK_PEM_PUBLIC_KEY 解码，返回 JWT payload。"""
        try:
            decoded_token = jwt.decode(
                token,
                get_settings().clerk_pem_public_key,
                algorithms=["RS256"],
            )
            if not isinstance(decoded_token, dict):
                log.warning("get_payload: JWT payload is not an object")
                raise JwtInvalidTokenError("Invalid token")
            user_id = decoded_token.get("sub")
            if not user_id:
                log.warning("get_payload: JWT token missing subject")
                raise JwtInvalidTokenError("Invalid token")
            return decoded_token
        except jwt.ExpiredSignatureError as error:
            log.warning("get_payload: token has expired, error=%s", error)
            raise JwtExpiredTokenError("Token has expired") from error
        except jwt.InvalidTokenError as error:
            log.warning("get_payload: invalid token, error=%s", error)
            raise JwtInvalidTokenError("Invalid token") from error

    @staticmethod
    async def get_user_id_with_backoff(token: str) -> str:
        """用 RS256 和 CLERK_PEM_PUBLIC_KEY 解码，返回 payload 的 sub。"""
        payload = await JwtService.get_payload_with_backoff(token)
        return str(payload["sub"])
