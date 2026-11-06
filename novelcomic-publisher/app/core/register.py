"""应用启动时注册路由、认证中间件和 Publisher 索引。"""

from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute
from starlette.middleware.authentication import AuthenticationMiddleware

from app.controller.routers import developer_v1, internal, v1, v2, v3
from app.database.mongo import (
    ensure_agent_catalog_indexes,
    ensure_agent_skill_indexes,
    ensure_asset_library_indexes,
    ensure_b2b_signal_indexes,
    ensure_credits_inout_indexes,
    ensure_developer_indexes,
    ensure_invite_indexes,
    ensure_media_face_verifications_indexes,
    ensure_subscription_checkout_intent_indexes,
    ensure_user_preferences_indexes,
    ensure_workflow_v2_indexes,
    test_mongo,
)
from app.middleware.auth_middleware import AuthErrorMiddleware, ClerkAuthenticationBackend
from app.middleware.trace_id_middlewares import TraceIDMiddleware


async def register_init(database: Any) -> None:
    """`test_mongo()` 成功之后、后台任务之前建索引。

    Developer API 不是独立进程，所以 `ensure_developer_indexes()` 只在这里调用。
    """

    await test_mongo(database)
    await ensure_developer_indexes(database)
    await ensure_invite_indexes(database)
    await ensure_credits_inout_indexes(database)
    await ensure_subscription_checkout_intent_indexes(database)
    await ensure_b2b_signal_indexes(database)
    await ensure_media_face_verifications_indexes(database)
    await ensure_user_preferences_indexes(database)
    await ensure_asset_library_indexes(database)
    await ensure_agent_skill_indexes(database)
    await ensure_agent_catalog_indexes(database)
    await ensure_workflow_v2_indexes(database)


def register_middleware(app: FastAPI) -> None:
    """挂上验签、401 包装和 HTTP trace。后加的 TraceIDMiddleware 在这三层最外。"""
    app.add_middleware(AuthenticationMiddleware, backend=ClerkAuthenticationBackend())
    app.add_middleware(AuthErrorMiddleware)
    app.add_middleware(TraceIDMiddleware)


def register_router(app: FastAPI) -> None:
    """把 v1 和 v2 路由挂到应用上，并检查路由名不重复。"""
    app.include_router(v1)
    app.include_router(v2)
    app.include_router(v3)
    app.include_router(developer_v1)
    app.include_router(internal)
    _ensure_unique_route_names(app)


def _ensure_unique_route_names(app: FastAPI) -> None:
    names: set[str] = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        if route.name in names:
            raise ValueError(f"Non-unique route name: {route.name}")
        names.add(route.name)
