"""Comic product routes reuse the agent user as the tenant."""

from fastapi import Request

from novelcomic_agent.api.server import _authenticate_agent_user
from novelcomic_agent.config import Settings

from .product_routes import Authenticator


def comic_authenticator(settings: Settings) -> Authenticator:
    """Return the authenticated user id. Request bodies do not choose the tenant."""

    async def authenticate(request: Request) -> str:
        user = _authenticate_agent_user(
            authorization=request.headers.get("authorization"),
            requested_user_id=request.headers.get("x-user-id"),
            settings=settings,
        )
        return user.user_id

    return authenticate
