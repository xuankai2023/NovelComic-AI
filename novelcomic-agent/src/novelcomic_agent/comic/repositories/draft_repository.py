"""Draft revisions and the replay-safe Compose command ledger."""

from __future__ import annotations

from typing import Any

from ..contracts.compose_command import ComposeCommandInput
from ..contracts.errors import ComicServiceError
from ..contracts.ids import CommandId, ProjectId
from ..drafts.draft_repository import BeginCommandResult, DraftRecord, DraftRepository
from ..persistence.ledger import Ledger
from ..persistence.rows import CommandRow, utcnow


class LedgerDraftRepository(DraftRepository):
    """PostgreSQL-shaped draft CAS over the shared ledger transaction."""

    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def get(self, project_id: ProjectId) -> DraftRecord:
        async with self._ledger.transaction() as session:
            row = await session.get_draft(project_id)
        if row is None:
            raise ComicServiceError(
                "DRAFT_NOT_FOUND",
                "committed draft was not found",
                retryable=False,
                details={"projectId": project_id},
            )
        return _record(row.project_id, row.revision, row.project_json, row.content_hash)

    async def get_revision(self, project_id: str, revision: int) -> DraftRecord:
        async with self._ledger.transaction() as session:
            row = await session.get_draft_revision(project_id, revision)
        if row is None:
            raise ComicServiceError(
                "DRAFT_NOT_FOUND",
                "requested draft revision was not found",
                retryable=False,
                details={"projectId": project_id, "revision": revision},
            )
        return _record(row.project_id, row.revision, row.project_json, row.content_hash)

    async def create(self, draft: DraftRecord) -> None:
        from ..persistence.rows import DraftRevisionRow, DraftRow

        now = utcnow()
        async with self._ledger.transaction() as session:
            await session.insert_draft(
                DraftRow(
                    project_id=draft.project_id,
                    revision=draft.revision,
                    project_json=draft.project,
                    content_hash=draft.content_hash,
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.insert_draft_revision(
                DraftRevisionRow(
                    project_id=draft.project_id,
                    revision=draft.revision,
                    project_json=draft.project,
                    content_hash=draft.content_hash,
                    command_id=None,
                    created_at=now,
                )
            )

    async def begin_command(
        self,
        command: ComposeCommandInput,
        expected_revision: int,
    ) -> BeginCommandResult:
        now = utcnow()
        async with self._ledger.transaction() as session:
            existing = await session.get_command(command.command_id)
            if existing is not None:
                _require_same_command(existing, command)
                if existing.status == "committed":
                    return BeginCommandResult("committed", existing.resulting_revision)
                existing.status = "running"
                existing.expected_revision = expected_revision
                existing.attempt += 1
                existing.last_error_code = None
                existing.updated_at = now
                await session.save_command(existing)
                return BeginCommandResult("started", None)
            clash = await session.find_command_by_ordinal(command.project_id, command.ordinal)
            if clash is not None:
                raise ComicServiceError(
                    "COMPOSE_COMMAND_CONFLICT",
                    "compose ordinal is already used by another command",
                    retryable=False,
                    details={"commandId": command.command_id, "ordinal": command.ordinal},
                )
            await session.insert_command(
                CommandRow(
                    command_id=command.command_id,
                    project_id=command.project_id,
                    ordinal=command.ordinal,
                    name=command.name,
                    input_hash=command.input_hash,
                    expected_revision=expected_revision,
                    resulting_revision=None,
                    status="running",
                    attempt=1,
                    last_error_code=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        return BeginCommandResult("started", None)

    async def commit_command_cas(
        self,
        *,
        command_id: CommandId,
        project_id: ProjectId,
        expected_revision: int,
        new_project: dict[str, Any],
        new_content_hash: str,
    ) -> int:
        async with self._ledger.transaction() as session:
            revision = await session.commit_draft(
                command_id=command_id,
                project_id=project_id,
                expected_revision=expected_revision,
                new_project=new_project,
                new_content_hash=new_content_hash,
            )
            if revision is not None:
                return revision
            current = await session.get_command(command_id)
        if (
            current is not None
            and current.status == "committed"
            and current.resulting_revision is not None
        ):
            return current.resulting_revision
        raise ComicServiceError(
            "DRAFT_REVISION_CONFLICT",
            "draft revision changed before the compose command committed",
            retryable=True,
            details={"commandId": command_id, "projectId": project_id},
        )

    async def fail_command(self, command_id: CommandId, error_code: str) -> None:
        async with self._ledger.transaction() as session:
            current = await session.get_command(command_id)
            if current is None or current.status == "committed":
                return
            current.status = "failed"
            current.last_error_code = error_code
            await session.save_command(current)


def _record(
    project_id: str,
    revision: int,
    project: dict[str, Any],
    content_hash: str,
) -> DraftRecord:
    return DraftRecord(
        project_id=project_id,
        revision=revision,
        project=project,
        content_hash=content_hash,
    )


def _require_same_command(existing: CommandRow, command: ComposeCommandInput) -> None:
    if (
        existing.project_id != command.project_id
        or existing.ordinal != command.ordinal
        or existing.name != command.name
        or existing.input_hash != command.input_hash
    ):
        raise ComicServiceError(
            "COMPOSE_COMMAND_CONFLICT",
            "compose command id was reused with a different payload",
            retryable=False,
            details={"commandId": command.command_id},
        )
