"""Internal API routes."""

from fastapi import APIRouter

from app.controller.internal.model_config import router as model_config_router
from app.controller.internal.workflow import router as workflow_router

router = APIRouter(prefix="/api/internal")
router.include_router(model_config_router, prefix="/model-config", tags=["Internal Model Config"])
router.include_router(workflow_router, prefix="/workflow", tags=["Internal Workflow"])
