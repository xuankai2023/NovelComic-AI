"""从中间件写入的 request.user 取出当前用户。"""

import logging

from fastapi import Request

from app.middleware.auth_middleware import AuthUser

log = logging.getLogger(__name__)


def get_authenticated_user(request: Request) -> AuthUser:
    authenticated_user = request.user
    log.info("authenticated_user=%s", authenticated_user)
    return authenticated_user
