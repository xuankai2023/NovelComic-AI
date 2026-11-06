"""Read and validate a committed draft revision. Local JSON cannot replace it."""

from __future__ import annotations

from typing import Any

from ..contracts.errors import ComicServiceError
from ..rendering.remotion_client import RenderingGateway
from ..repositories.draft_repository import LedgerDraftRepository


class ProjectTools:
    def __init__(self, drafts: LedgerDraftRepository, remotion: RenderingGateway) -> None:
        self._drafts = drafts
        self._remotion = remotion

    async def read(self, project_id: str, revision: int) -> dict[str, Any]:
        draft = await self._drafts.get_revision(project_id, revision)
        return {
            "projectId": draft.project_id,
            "revision": draft.revision,
            "contentHash": draft.content_hash,
            "project": draft.project,
        }

    async def validate(self, project_id: str, revision: int) -> dict[str, Any]:
        draft = await self._drafts.get_revision(project_id, revision)
        report = await self._remotion.validate_project(draft.project)
        summary = await self._remotion.summarize_project(draft.project)
        return {
            "projectId": draft.project_id,
            "revision": draft.revision,
            "contentHash": draft.content_hash,
            "valid": report.valid,
            "issues": list(report.issues),
            "summary": summary,
        }

    def overwrite_draft(self, *_args: object, **_kwargs: object) -> None:
        raise ComicServiceError(
            "INVALID_REQUEST",
            "local JSON cannot overwrite a committed draft",
            retryable=False,
        )
