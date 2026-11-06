"""Custom workflow order endpoints (/api/v1/custom_workflow/*)."""

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser

router = APIRouter()
CUSTOM_WORKFLOW_ORDERS_COLLECTION = "custom_workflow_orders"


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


class CustomWorkflowCheckoutBody(BaseModel):
    title: str = Field(default="Custom Workflow Order", min_length=1, max_length=120)
    requirements: str = Field(min_length=1, max_length=4000)
    contact_email: str | None = Field(default=None, max_length=120)
    budget_usd: int = Field(default=199, ge=1)
    reference_urls: list[str] = Field(default_factory=list)


@router.post("/checkout", summary="创建定制工作流订单与 Checkout Session")
async def create_custom_workflow_checkout_endpoint(
    request: Request,
    body: CustomWorkflowCheckoutBody,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    settings = get_settings()
    database = _database(request)
    order_id = f"cwo_{uuid4().hex[:16]}"
    session_id = f"cs_cwo_{uuid4().hex[:16]}"
    now = datetime.now(UTC).isoformat()
    base_url = getattr(settings, "frontend_url", "http://localhost:5173").rstrip("/")
    checkout_url = f"{base_url}/custom-workflow?order_id={order_id}&session_id={session_id}"

    order_doc = {
        "order_id": order_id,
        "user_id": user.user_id,
        "title": body.title.strip(),
        "requirements": body.requirements.strip(),
        "contact_email": (body.contact_email or "").strip() or None,
        "budget_usd": body.budget_usd,
        "reference_urls": list(body.reference_urls),
        "session_id": session_id,
        "checkout_url": checkout_url,
        "status": "pending_payment",
        "created_at": now,
        "updated_at": now,
    }
    await database[CUSTOM_WORKFLOW_ORDERS_COLLECTION].insert_one(dict(order_doc))
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {
                "order_id": order_id,
                "session_id": session_id,
                "checkout_url": checkout_url,
                "status": "pending_payment",
            },
        },
    )


@router.get("/orders", summary="列出当前用户的定制工作流订单")
async def list_custom_workflow_orders_endpoint(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> JSONResponse:
    database = _database(request)
    query = {"user_id": user.user_id}
    total = int(await database[CUSTOM_WORKFLOW_ORDERS_COLLECTION].count_documents(query))
    skip = (page - 1) * page_size
    cursor = (
        database[CUSTOM_WORKFLOW_ORDERS_COLLECTION]
        .find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(page_size)
    )
    if hasattr(cursor, "to_list"):
        items = await cursor.to_list(length=page_size)
    else:
        items = list(cursor)
    return JSONResponse(
        status_code=200,
        content={
            "code": 200,
            "msg": "ok",
            "data": {
                "list": [dict(item) for item in items],
                "total": total,
                "page": page,
                "page_size": page_size,
            },
        },
    )


@router.get("/orders/{order_id}", summary="查询单笔定制工作流订单详情")
async def get_custom_workflow_order_endpoint(
    order_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    database = _database(request)
    doc = await database[CUSTOM_WORKFLOW_ORDERS_COLLECTION].find_one(
        {"order_id": order_id, "user_id": user.user_id},
        {"_id": 0},
    )
    if doc is None:
        return JSONResponse(
            status_code=404,
            content={"code": 1004, "msg": "Custom workflow order not found", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": dict(doc)})
