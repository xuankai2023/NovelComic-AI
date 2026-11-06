"""把各版本路由挂到统一前缀。登录路由内部已有 /auth，这里不再加 API Key。"""

from fastapi import APIRouter

from app.controller.internal import router as internal_router
from app.controller.v1.cli import router as cli_router_v1
from app.controller.v1.custom_workflow import router as custom_workflow_router_v1
from app.controller.v1.developer_task import router as developer_task_router_v1
from app.controller.v1.feishu import router as feishu_router_v1
from app.controller.v1.gift_credits import router as gift_credits_router_v1
from app.controller.v1.miniapp import router as miniapp_router_v1
from app.controller.v1.models import router as models_router_v1
from app.controller.v1.node_blocks import router as node_blocks_router_v1
from app.controller.v1.payments import router as payments_router_v1
from app.controller.v1.social_auth import router as social_auth_router_v1
from app.controller.v1.template import router as template_router_v1
from app.controller.v1.user import router as user_router_v1
from app.controller.v2.auth import router as auth_router_v2
from app.controller.v2.b2b_signal import router as b2b_signal_router_v2
from app.controller.v2.cos import router as cos_router_v2
from app.controller.v2.flow_runs import router as flow_runs_router_v2
from app.controller.v2.payments import router as payments_router_v2
from app.controller.v2.share import router as share_router_v2
from app.controller.v2.usage import router as usage_router_v2
from app.controller.v2.user import router as user_router_v2
from app.controller.v2.workflow_project import router as workflow_project_router_v2
from app.controller.v3.agent_catalog import router as agent_catalog_router_v3
from app.controller.v3.agent_skills import router as agent_skills_router_v3
from app.controller.v3.app_flow import router as app_flow_router_v3
from app.controller.v3.assets import router as assets_router_v3
from app.controller.v3.developer_api_client import router as developer_api_client_router_v3
from app.controller.v3.image_segmentation import router as image_segmentation_router_v3
from app.controller.v3.media_face_verifications import router as media_face_verifications_router_v3
from app.controller.v3.result import router as result_router_v3
from app.controller.v3.share import router as share_router_v3
from app.developer_api.routers import developer_v1_router

v1 = APIRouter(prefix="/api/v1")
v1.include_router(user_router_v1, prefix="/user", tags=["用户接口"])
v1.include_router(models_router_v1, prefix="/models", tags=["Models V1"])
v1.include_router(template_router_v1, prefix="/templates", tags=["Templates V1"])
v1.include_router(payments_router_v1, prefix="/payments", tags=["Payments V1"])
v1.include_router(gift_credits_router_v1, prefix="/gift_credits", tags=["Gift Credits V1"])
v1.include_router(social_auth_router_v1, prefix="/social_auth", tags=["Social Auth V1"])
v1.include_router(feishu_router_v1, prefix="/feishu", tags=["Feishu V1"])
v1.include_router(cli_router_v1, prefix="/cli", tags=["CLI V1"])
v1.include_router(developer_task_router_v1, prefix="/task", tags=["Developer Task V1"])
v1.include_router(node_blocks_router_v1, prefix="/node_blocks", tags=["Node Blocks V1"])
v1.include_router(custom_workflow_router_v1, prefix="/custom_workflow", tags=["Custom Workflow V1"])
v1.include_router(miniapp_router_v1, prefix="/miniapp", tags=["Miniapp V1"])

v2 = APIRouter(prefix="/api/v2")
v2.include_router(
    auth_router_v2,
    tags=["Auth V2"],
)
v2.include_router(user_router_v2, prefix="/user", tags=["用户接口 V2"])
v2.include_router(workflow_project_router_v2, prefix="/flow", tags=["Flow Project V2"])
v2.include_router(flow_runs_router_v2, prefix="/flow", tags=["Flow Runs V2"])
v2.include_router(cos_router_v2, prefix="/cos", tags=["COS V2"])
v2.include_router(share_router_v2, prefix="/share", tags=["Share V2"])
v2.include_router(b2b_signal_router_v2, prefix="/b2b-signal", tags=["B2B Signal V2"])
v2.include_router(payments_router_v2, prefix="/payments", tags=["Payments V2"])
v2.include_router(usage_router_v2, prefix="/usage", tags=["Usage V2"])

v3 = APIRouter(prefix="/api/v3")
v3.include_router(assets_router_v3, prefix="/assets", tags=["Assets V3"])
v3.include_router(
    image_segmentation_router_v3,
    prefix="/image-segmentation",
    tags=["Image Segmentation V3"],
)
v3.include_router(
    media_face_verifications_router_v3,
    prefix="/media-face-verifications",
    tags=["Media Face Verifications V3"],
)
v3.include_router(result_router_v3, prefix="/result", tags=["Result V3"])
v3.include_router(share_router_v3, prefix="/share", tags=["Share V3"])
v3.include_router(app_flow_router_v3, prefix="/app-flow", tags=["App Flow V3"])
v3.include_router(agent_catalog_router_v3, prefix="/agent-catalog", tags=["Agent Catalog V3"])
v3.include_router(agent_skills_router_v3, prefix="/agent-skills", tags=["Agent Skills V3"])
v3.include_router(
    developer_api_client_router_v3,
    prefix="/developer",
    tags=["Developer API Client V3"],
)

developer_v1 = developer_v1_router
internal = internal_router
