"""Account management endpoints for Developer API keys (/api/v3/developer/api-client)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dao.developer_api_client import DeveloperApiClientDao
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.developer_api_client import CreateDeveloperApiClientRequest

router = APIRouter()


def _database(request: Request) -> Any:
    settings = get_settings()
    return request.app.state.connections.mongo[settings.mongo_database]


@router.post("/api-client", summary="创建 Developer API Key")
async def create_developer_api_client_endpoint(
    request: Request,
    body: CreateDeveloperApiClientRequest,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    client = await DeveloperApiClientDao.create(
        _database(request),
        owner_user_id=user.user_id,
        name=body.name,
        rate_limit_per_minute=body.rate_limit_per_minute,
    )
    data = client.model_dump(mode="json", exclude={"api_key_hash"})
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": data})


@router.get("/api-client", summary="列出当前用户的 Developer API Keys")
async def list_developer_api_clients_endpoint(
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    records = await DeveloperApiClientDao.list_by_owner(_database(request), user.user_id)
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": records})


@router.delete("/api-client/{client_id}", summary="吊销 Developer API Key")
async def revoke_developer_api_client_endpoint(
    client_id: str,
    request: Request,
    user: Annotated[AuthUser, Depends(get_authenticated_user)],
) -> JSONResponse:
    revoked = await DeveloperApiClientDao.revoke(
        _database(request),
        client_id=client_id,
        owner_user_id=user.user_id,
    )
    if not revoked:
        return JSONResponse(
            status_code=404,
            content={"code": 1004, "msg": "API client not found", "data": None},
        )
    return JSONResponse(status_code=200, content={"code": 200, "msg": "ok", "data": None})
