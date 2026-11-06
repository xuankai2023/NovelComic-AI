"""未捕获异常上报 Sentry。已经转成明确业务响应的异常留在业务分支。"""

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


def _capture_exception(exc: Exception) -> None:
    try:
        import sentry_sdk

        sentry_sdk.capture_exception(exc)
    except Exception:
        logger.warning("sentry capture failed", exc_info=True)


def register_exception(app: FastAPI) -> None:
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        del request
        if isinstance(exc, HTTPException):
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers=getattr(exc, "headers", None),
            )
        _capture_exception(exc)
        logger.exception("Unhandled exception occurred")
        return JSONResponse(
            status_code=500,
            content={"code": 500, "msg": "Internal server error", "data": None},
        )
