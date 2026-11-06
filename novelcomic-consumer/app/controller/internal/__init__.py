from fastapi import APIRouter, FastAPI

from app.controller.internal.errors import InternalAPIError, internal_api_error_handler
from app.controller.internal.workflow import router as workflow_router

INTERNAL_API_PREFIX = "/api/internal"

internal_api_router = APIRouter(prefix=INTERNAL_API_PREFIX)
internal_api_router.include_router(workflow_router, prefix="/workflow", tags=["internal"])


def register_internal_api(app: FastAPI) -> None:
    app.include_router(internal_api_router)
    app.add_exception_handler(InternalAPIError, internal_api_error_handler)
