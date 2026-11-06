"""HTTP 认证入口。内部路由验服务密钥，其余非白名单路径验 JWT。"""

import base64
import fnmatch
import logging
import secrets

from fastapi import Request
from pydantic import BaseModel
from starlette.authentication import (
    AuthCredentials,
    AuthenticationBackend,
    AuthenticationError,
    BaseUser,
)
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response

from app.config import get_settings
from app.legacy import note_v1_flow_path
from app.services.jwt import JwtAuthenticationError, JwtService

log = logging.getLogger(__name__)

# 公开路径不走 Clerk JWT：健康检查、文档、发码登录、COS、模型列表、catalog、
# 用户创建、支付 webhook、社交 webhook、飞书。
# 不含 /api/v1/flow/*。internal model-config 走 /api/internal/* 的服务密钥。
WHITE_LIST = [
    "/health",
    "/health2",
    "/health/consumer",
    "/readyz",
    "/docs",
    "/docs/*",
    "/redoc",
    "/redoc/*",
    "/openapi.json",
    "/api/v2/auth/send-code",
    "/api/v2/auth/login-with-code",
    "/api/v2/auth/register-with-code",
    "/api/v2/auth/login-with-password",
    "/api/v2/cos/*",
    "/api/v1/models/*",
    "/api/v1/templates/*",
    "/api/v3/agent-catalog/*",
    "/api/v1/user/create",
    "/api/v1/payments/webhook",
    "/api/v1/payments/subscription/template",
    "/api/v1/payments/subscription/stripe_plan_config",
    "/api/v1/social_auth/webhooks/*",
    "/api/v1/feishu/*",
    "/api/developer/v1/*",
    "/api/v1/cli/device/code",
    "/api/v1/cli/device/token",
    "/api/v1/cli/info",
    "/api/v1/cli/logout",
]
METHOD_WHITE_LIST = [
    ("GET", "/api/v3/share/*/info"),
]

AUTH_ERROR_RESPONSE_FIELD_KEY = "auth_error_response"
_UNAUTHORIZED = 1002


class AuthUser(BaseModel, BaseUser):
    user_id: str
    email: str | None = None

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def display_name(self) -> str:
        return self.user_id

    @property
    def identity(self) -> str:
        return self.user_id


PUBLIC_USER = AuthUser(user_id="")
SERVICE_USER = AuthUser(user_id="service")
_INTERNAL_PATH = "/api/internal/*"


def _is_recoverable_v2_events_socket(path: str) -> bool:
    """v2 可恢复事件连接在 handler 里验第一条 auth，中间件这里放行。"""

    parts = [part for part in path.split("/") if part]
    return len(parts) == 7 and parts[:4] == ["api", "v2", "flow", "runs"] and parts[5] == "events"


def _auth_response(status_code: int, msg: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": _UNAUTHORIZED, "msg": msg, "data": None},
    )


def _unauthorized(msg: str) -> JSONResponse:
    return _auth_response(401, msg)


class ClerkAuthenticationBackend(AuthenticationBackend):
    @staticmethod
    def _reject_internal(conn: HTTPConnection, status_code: int, msg: str) -> None:
        conn.scope[AUTH_ERROR_RESPONSE_FIELD_KEY] = _auth_response(status_code, msg)
        raise AuthenticationError(msg)

    def _authenticate_internal(self, conn: HTTPConnection):
        configured_key = get_settings().internal_api_key
        if not configured_key:
            self._reject_internal(conn, 503, "internal API is not configured")
        authorization = conn.headers.get("Authorization") or ""
        decoded_key = ""
        if authorization:
            try:
                decoded_key = base64.b64decode(
                    authorization.encode("utf-8"),
                    validate=True,
                ).decode("utf-8")
            except Exception:
                decoded_key = ""
        if (
            not authorization
            or not decoded_key
            or not secrets.compare_digest(decoded_key, configured_key)
        ):
            message = (
                "missing authorization value for internal endpoint"
                if not authorization
                else "invalid authorization value for internal endpoint"
            )
            self._reject_internal(conn, 401, message)
        log.info("Passed authentication for internal endpoints")
        return AuthCredentials(["authenticated"]), SERVICE_USER

    async def authenticate(self, conn: HTTPConnection):
        path = conn.url.path or "/"
        note_v1_flow_path(path)
        http_method = conn.scope.get("method")
        conn_type = conn.scope.get("type")
        skip_auth = AuthCredentials(["authenticated"]), PUBLIC_USER
        try:
            if fnmatch.fnmatch(path, _INTERNAL_PATH):
                return self._authenticate_internal(conn)
            if any(fnmatch.fnmatch(path, pattern) for pattern in WHITE_LIST):
                log.info("Skip authentication: path=%s", path)
                return skip_auth
            if any(
                http_method == method and fnmatch.fnmatch(path, pattern)
                for method, pattern in METHOD_WHITE_LIST
            ):
                log.info("Skip authentication: method=%s path=%s", http_method, path)
                return skip_auth
            if conn_type == "websocket" and _is_recoverable_v2_events_socket(path):
                log.info("Skip authentication: recoverable v2 events path=%s", path)
                return skip_auth

            jwt_token = None
            if conn_type == "http" and http_method == "OPTIONS":
                return skip_auth
            if conn_type in {"http", "websocket"}:
                authorization_field = conn.headers.get("Authorization")
                if not authorization_field:
                    raise AuthenticationError("Authorization field is required")
                bearer_prefix = "Bearer "
                jwt_token = (
                    authorization_field.startswith(bearer_prefix)
                    and authorization_field[len(bearer_prefix) :]
                    or authorization_field
                )
            if not jwt_token:
                raise AuthenticationError("JWT token is required")
            try:
                payload = await JwtService.get_payload_with_backoff(token=jwt_token)
                user_id = str(payload["sub"])
                email = payload.get("email") or payload.get("primary_email_address")
                if isinstance(email, str):
                    email = email.strip().lower() or None
                else:
                    email = None
                log.info("Successfully authenticated user_id=%s", user_id)
                return AuthCredentials(["authenticated"]), AuthUser(user_id=user_id, email=email)
            except JwtAuthenticationError as error:
                log.warning("Authentication rejected. error=%s", error)
                raise AuthenticationError(str(error)) from error
            except Exception as error:
                log.exception("Authentication failed")
                raise AuthenticationError(str(error)) from error
        except Exception as error:
            if isinstance(error, AuthenticationError):
                log.warning("Authentication rejected: %s", error)
                conn.scope.setdefault(AUTH_ERROR_RESPONSE_FIELD_KEY, _unauthorized(str(error)))
            else:
                log.exception("Authentication failed")
            raise


class AuthErrorMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path in {"/readyz", "/health", "/health2", "/health/consumer"}:
            return await call_next(request)

        response = await call_next(request)
        if AUTH_ERROR_RESPONSE_FIELD_KEY in request.scope:
            response = request.scope[AUTH_ERROR_RESPONSE_FIELD_KEY]
        return response
