"""Personal Agent Skill asset API. These records are not runtime tools."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.middleware.auth_middleware import AuthUser
from app.schemas.agent_skills import (
    CreateAgentSkillRequest,
    GenerateAgentSkillDraftRequest,
    UpdateAgentSkillRequest,
)
from app.services.agent_skills import AgentSkillsService

router = APIRouter()


def _database(request: Request) -> Any:
    return request.app.state.connections.mongo[get_settings().mongo_database]


def _require_user(user: Annotated[AuthUser, Depends(get_authenticated_user)]) -> AuthUser:
    if not getattr(user, "is_authenticated", False) or not getattr(user, "user_id", ""):
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"})
    return user


def _ok(data: Any, status_code: int = 200) -> JSONResponse:
    body = {"code": status_code, "msg": "ok", "data": jsonable_encoder(data)}
    return JSONResponse(status_code=status_code, content=body)


@router.get("/personal")
async def list_personal_agent_skills(
    request: Request,
    user: Annotated[AuthUser, Depends(_require_user)],
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    query_text: str | None = None,
) -> JSONResponse:
    page_data = await AgentSkillsService.list_personal(
        _database(request),
        user.user_id,
        page=page,
        page_size=page_size,
        query_text=query_text,
    )
    return _ok(page_data.model_dump(mode="json"))


@router.post("/generate-draft")
async def generate_agent_skill_draft(
    body: GenerateAgentSkillDraftRequest,
    user: Annotated[AuthUser, Depends(_require_user)],
) -> JSONResponse:
    del user
    return _ok(await AgentSkillsService.generate_draft(body))


@router.post("")
async def create_agent_skill(
    request: Request,
    body: CreateAgentSkillRequest,
    user: Annotated[AuthUser, Depends(_require_user)],
) -> JSONResponse:
    created = await AgentSkillsService.create_personal(_database(request), user.user_id, body)
    return _ok(created.model_dump(mode="json"), status_code=201)


@router.patch("/personal/{skill_id}")
async def update_personal_agent_skill(
    request: Request,
    skill_id: str,
    body: UpdateAgentSkillRequest,
    user: Annotated[AuthUser, Depends(_require_user)],
) -> JSONResponse:
    updated = await AgentSkillsService.update_personal(
        _database(request),
        user.user_id,
        skill_id,
        body,
    )
    return _ok(updated.model_dump(mode="json"))


@router.delete("/personal/{skill_id}")
async def delete_personal_agent_skill(
    request: Request,
    skill_id: str,
    user: Annotated[AuthUser, Depends(_require_user)],
) -> JSONResponse:
    await AgentSkillsService.delete_personal(_database(request), user.user_id, skill_id)
    return _ok({"skill_id": skill_id, "deleted": True})
