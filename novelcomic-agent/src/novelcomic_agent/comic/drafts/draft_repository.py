"""Persistence protocol for drafts and the Compose command ledger."""

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ..contracts.compose_command import ComposeCommandInput
from ..contracts.ids import CommandId, ProjectId


@dataclass(frozen=True, slots=True)
class DraftRecord:
    project_id: ProjectId
    revision: int
    project: dict[str, Any]
    content_hash: str


@dataclass(frozen=True, slots=True)
class BeginCommandResult:
    status: Literal["started", "committed"]
    resulting_revision: int | None = None


class DraftRepository(Protocol):
    async def get(self, project_id: ProjectId) -> DraftRecord:
        """Read the latest committed draft."""

    async def create(self, draft: DraftRecord) -> None:
        """Create revision zero in the production acceptance transaction."""

    async def begin_command(
        self,
        command: ComposeCommandInput,
        expected_revision: int,
    ) -> BeginCommandResult:
        """Create/reopen the ledger row or return its committed replay receipt."""

    async def commit_command_cas(
        self,
        *,
        command_id: CommandId,
        project_id: ProjectId,
        expected_revision: int,
        new_project: dict[str, Any],
        new_content_hash: str,
    ) -> int:
        """Atomically CAS the draft and mark the command committed."""

    async def fail_command(self, command_id: CommandId, error_code: str) -> None:
        """Record failure unless the command is already committed."""
