from fastapi import HTTPException, Request
from starlette.responses import JSONResponse


class InternalAPIError(HTTPException):
    """HTTP error that must preserve its status for service-to-service callers."""


async def internal_api_error_handler(
    _request: Request,
    exc: InternalAPIError,
) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=exc.headers,
    )
