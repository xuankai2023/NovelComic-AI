"""公开登录路由。只收参、取 IP，再调 AuthService。不验签。"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.auth import (
    ChangePasswordRequest,
    ChangePasswordResponse,
    LoginResponse,
    LoginWithCodeRequest,
    LoginWithPasswordRequest,
    RegisterResponse,
    RegisterWithCodeRequest,
    SendCodeRequest,
    SendCodeResponse,
)
from app.services.auth_service import (
    AuthService,
    EmailSendError,
    InvalidCodeError,
    InvalidPasswordError,
    RateLimitError,
    UserNotFoundError,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth")

_CLIENT_ERROR = 1000
_UNAUTHORIZED = 1002
_TOO_MANY_REQUEST = 1005
_UNKNOWN_ERROR = 1007
_NOT_FOUND = 1010


def _ok(data: dict, msg: str) -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": msg, "data": data})


def _fail(msg: str, http_code: int, code: int) -> JSONResponse:
    return JSONResponse(
        status_code=http_code,
        content={"code": code, "msg": msg, "data": None},
    )


def _client_ip(request: Request) -> str | None:
    """优先取 X-Forwarded-For 的第一段，否则用连接地址。"""
    client_ip = request.client.host if request.client else None
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        client_ip = forwarded_for.split(",")[0].strip()
    return client_ip


@router.post("/send-code", summary="发送验证码")
async def send_verification_code(body: SendCodeRequest) -> JSONResponse:
    try:
        log.info("收到发送验证码请求: email=%s", body.email)
        result = await AuthService.send_verification_code(
            email=body.email,
            fp_hash=body.fp_hash,
            fp_time=body.fp_time,
        )
        return _ok(SendCodeResponse(**result).model_dump(), "验证码已发送")
    except RateLimitError as error:
        log.warning("发送频率限制: email=%s, error=%s", body.email, error)
        return _fail(str(error), 429, _TOO_MANY_REQUEST)
    except EmailSendError:
        log.exception("邮件发送失败: email=%s", body.email)
        return _fail("邮件发送失败,请稍后重试", 500, _UNKNOWN_ERROR)
    except Exception:
        log.exception("发送验证码异常: email=%s", body.email)
        return _fail("系统错误,请稍后重试", 500, _UNKNOWN_ERROR)


@router.post("/login-with-code", summary="验证码登录")
async def login_with_code(body: LoginWithCodeRequest) -> JSONResponse:
    try:
        log.info("收到验证码登录请求: email=%s", body.email)
        result = await AuthService.verify_code_and_login(body.email, body.code)
        return _ok(LoginResponse(**result).model_dump(), "登录成功")
    except InvalidCodeError as error:
        log.warning("验证码错误: email=%s, error=%s", body.email, error)
        return _fail(str(error), 400, _CLIENT_ERROR)
    except UserNotFoundError as error:
        log.warning("用户不存在: email=%s", body.email)
        return _fail(str(error), 404, _NOT_FOUND)
    except Exception:
        log.exception("验证码登录异常: email=%s", body.email)
        return _fail("系统错误,请稍后重试", 500, _UNKNOWN_ERROR)


@router.post("/register-with-code", summary="验证码注册")
async def register_with_code(request: Request, body: RegisterWithCodeRequest) -> JSONResponse:
    client_ip = _client_ip(request)
    try:
        log.info("收到注册请求: email=%s, client_ip=%s", body.email, client_ip)
        result = await AuthService.register_with_code(
            email=body.email,
            code=body.code,
            client_ip=client_ip,
            source=body.source,
            invite_code=body.invite_code,
        )
        return _ok(RegisterResponse(**result).model_dump(), "注册成功")
    except InvalidCodeError as error:
        if "已注册" in str(error):
            log.warning("用户已存在: email=%s", body.email)
            return _fail(str(error), 409, _CLIENT_ERROR)
        log.warning("验证码错误: email=%s, error=%s", body.email, error)
        return _fail(str(error), 400, _CLIENT_ERROR)
    except Exception as error:
        if "已注册" in str(error):
            log.warning("用户已存在: email=%s", body.email)
            return _fail(str(error), 409, _CLIENT_ERROR)
        log.exception("验证码注册异常: email=%s", body.email)
        return _fail("系统错误,请稍后重试", 500, _UNKNOWN_ERROR)


@router.post("/login-with-password", summary="密码登录")
async def login_with_password(body: LoginWithPasswordRequest) -> JSONResponse:
    try:
        log.info("收到密码登录请求: email=%s", body.email)
        result = await AuthService.login_with_password(body.email, body.password)
        return _ok(LoginResponse(**result).model_dump(), "登录成功")
    except (InvalidPasswordError, UserNotFoundError) as error:
        log.warning("密码登录失败: email=%s, error=%s", body.email, error)
        return _fail("邮箱或密码错误", 401, _UNAUTHORIZED)
    except Exception:
        return _fail("系统错误,请稍后重试", 500, _UNKNOWN_ERROR)


@router.post("/change-password", summary="修改密码")
async def change_password(
    body: ChangePasswordRequest,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    if not user.user_id:
        return _fail("未认证", 401, _UNAUTHORIZED)
    try:
        log.info("收到修改密码请求: user_id=%s", user.user_id)
        await AuthService.change_password(user.user_id, body.old_password, body.new_password)
        return _ok(ChangePasswordResponse().model_dump(), "密码修改成功")
    except InvalidPasswordError:
        log.warning("旧密码错误: user_id=%s", user.user_id)
        return _fail("旧密码错误", 400, _CLIENT_ERROR)
    except Exception:
        log.exception("修改密码异常: user_id=%s", user.user_id)
        return _fail("系统错误,请稍后重试", 500, _UNKNOWN_ERROR)
