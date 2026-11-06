import base64
import secrets
from typing import Annotated

from fastapi import Header, status

from app.config import get_settings
from app.controller.internal.errors import InternalAPIError


async def verify_internal_api_key(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Accept ``Authorization: base64(INTERNAL_API_KEY)`` with no Bearer prefix."""

    if not get_settings().internal_api_key:
        raise InternalAPIError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="internal API is not configured",
        )
    if not authorization:
        raise InternalAPIError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing authorization value for internal endpoint",
        )
    try:
        decoded_key = base64.b64decode(authorization.encode("utf-8"), validate=True).decode("utf-8")
    except Exception as exc:
        raise InternalAPIError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid authorization value for internal endpoint",
        ) from exc
    if not secrets.compare_digest(decoded_key, get_settings().internal_api_key):
        raise InternalAPIError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid authorization value for internal endpoint",
        )
