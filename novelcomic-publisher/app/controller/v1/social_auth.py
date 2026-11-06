import asyncio
import logging
import os
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.social_post_request import SocialPostRequest, SocialPostRequestItem
from app.social.poster.tiktok_poster import tiktok_poster
from app.social.poster.x_poster import x_poster
from app.social.poster.youtube_poster import youtube_poster
from app.social.provider.__base.redis_keys import (
    TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX,
    TIKTOK_AUTH_REDIS_KEY_PREFIX,
    TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    X_ACCESS_TOKEN_REDIS_KEY_PREFIX,
    X_AUTH_REDIS_KEY_PREFIX,
    X_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX,
    YOUTUBE_AUTH_REDIS_KEY_PREFIX,
    YOUTUBE_REFRESH_TOKEN_REDIS_KEY_PREFIX,
)
from app.social.provider.base_provider import BaseProvider
from app.social.provider.tiktok_provider import tiktok_provider
from app.social.provider.x_provider import x_auth_provider
from app.social.provider.youtube_provider import youtube_provider

log = logging.getLogger(__name__)

router = APIRouter()

_CLIENT_ERROR = 1000
_UNKNOWN_ERROR = 1007
_STATE_TTL_SECONDS = 60 * 5
_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 23
_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 364


class _IntegrationConfig:
    def __init__(
        self,
        *,
        provider: BaseProvider,
        auth_prefix: str,
        access_prefix: str,
        refresh_prefix: str,
    ) -> None:
        self.provider = provider
        self.auth_prefix = auth_prefix
        self.access_prefix = access_prefix
        self.refresh_prefix = refresh_prefix


_INTEGRATIONS = {
    "tiktok": _IntegrationConfig(
        provider=tiktok_provider,
        auth_prefix=TIKTOK_AUTH_REDIS_KEY_PREFIX,
        access_prefix=TIKTOK_ACCESS_TOKEN_REDIS_KEY_PREFIX,
        refresh_prefix=TIKTOK_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    ),
    "youtube": _IntegrationConfig(
        provider=youtube_provider,
        auth_prefix=YOUTUBE_AUTH_REDIS_KEY_PREFIX,
        access_prefix=YOUTUBE_ACCESS_TOKEN_REDIS_KEY_PREFIX,
        refresh_prefix=YOUTUBE_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    ),
    "x": _IntegrationConfig(
        provider=x_auth_provider,
        auth_prefix=X_AUTH_REDIS_KEY_PREFIX,
        access_prefix=X_ACCESS_TOKEN_REDIS_KEY_PREFIX,
        refresh_prefix=X_REFRESH_TOKEN_REDIS_KEY_PREFIX,
    ),
}


@router.get("/generate_auth_url/{integration}", summary="生成社交平台授权地址")
async def generate_auth_url(
    request: Request,
    integration: str,
    redirect_uri: str,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    config = _get_integration(integration)
    if config is None:
        return _fail(f"Unsupported integration: {integration}", status_code=400)

    state = os.urandom(16).hex()
    auth_url = await config.provider.gen_auth_url(redirect_uri=redirect_uri, state=state)
    await request.app.state.connections.redis.setex(
        config.auth_prefix + user.user_id,
        _STATE_TTL_SECONDS,
        state,
    )
    return _ok(auth_url)


@router.get("/webhooks/{integration}", summary="社交平台 Webhook 空入口")
async def social_webhook(integration: str) -> JSONResponse:
    log.info("Social webhook received: integration=%s", integration)
    return _ok("ok")


@router.get("/callback/{integration}", summary="处理社交平台 OAuth 回调")
async def callback(
    request: Request,
    integration: str,
    code: str,
    state: str,
    redirect_uri: str,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    config = _get_integration(integration)
    if config is None:
        return _fail(f"Unsupported integration: {integration}", status_code=400)

    redis_client = request.app.state.connections.redis
    auth_key = config.auth_prefix + user.user_id
    redis_state = _decode_redis_value(await redis_client.get(auth_key))
    if redis_state != state:
        log.warning(
            "Social OAuth state mismatch: integration=%s user_id=%s",
            integration,
            user.user_id,
        )
        return _fail("OAuth state mismatch", status_code=400)

    token_info = await config.provider.get_token(code=code, redirect_uri=redirect_uri)
    access_token = token_info.get("access_token")
    refresh_token = token_info.get("refresh_token")
    if not access_token or not refresh_token:
        return _fail("Token response is missing access_token or refresh_token", status_code=502)

    await redis_client.delete(auth_key)
    await redis_client.setex(
        config.access_prefix + user.user_id,
        _ACCESS_TOKEN_TTL_SECONDS,
        str(access_token),
    )
    await redis_client.setex(
        config.refresh_prefix + user.user_id,
        _REFRESH_TOKEN_TTL_SECONDS,
        str(refresh_token),
    )
    return _ok("Auth Successful!")


@router.post("/post_video", summary="发布视频到社交平台")
async def post_video(
    request: Request,
    param: SocialPostRequest,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    if not param.post_items:
        return _fail("No post items provided", status_code=400)

    redis_client = request.app.state.connections.redis
    try:
        await asyncio.gather(
            *(
                _post_one(redis_client=redis_client, user=user, post_request=item)
                for item in param.post_items
            )
        )
    except Exception as error:
        log.exception("Failed to post social video")
        return _fail(str(error), status_code=500, code=_UNKNOWN_ERROR)
    return _ok(True, msg="Videos posted successfully")


async def _post_one(
    *,
    redis_client: Any,
    user: AuthUser,
    post_request: SocialPostRequestItem,
) -> None:
    if post_request.integration == "tiktok":
        await tiktok_poster.a_post(
            redis_client=redis_client,
            user=user,
            title=post_request.text,
            video_url=post_request.video_url,
        )
    elif post_request.integration == "youtube":
        await youtube_poster.a_post(
            redis_client=redis_client,
            user=user,
            title=post_request.text,
            description=post_request.description,
            video_url=post_request.video_url,
        )
    elif post_request.integration == "x":
        await x_poster.a_post(
            redis_client=redis_client,
            user=user,
            text=post_request.text,
            video_url=post_request.video_url,
        )
    else:
        raise ValueError(f"Unsupported integration: {post_request.integration}")


def _get_integration(integration: str) -> _IntegrationConfig | None:
    return _INTEGRATIONS.get(integration.lower())


def _decode_redis_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


def _ok(data: Any, *, msg: str = "ok") -> JSONResponse:
    return JSONResponse(status_code=200, content={"code": 200, "msg": msg, "data": data})


def _fail(msg: str, *, status_code: int = 400, code: int = _CLIENT_ERROR) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": code, "msg": msg, "data": None})
