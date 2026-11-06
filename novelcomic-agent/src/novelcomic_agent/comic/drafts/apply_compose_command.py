"""Replay-safe orchestration for one injected Remotion Compose call."""

from dataclasses import dataclass
from typing import Any, Protocol

from ..contracts.compose_command import ComposeCommandInput
from ..contracts.errors import ComicServiceError
from ..contracts.ids import CommandId
from .draft_repository import DraftRecord, DraftRepository


@dataclass(frozen=True, slots=True)
class ComposeResult:
    project: dict[str, Any]
    content_hash: str


class ComposeClient(Protocol):
    async def apply(
        self,
        *,
        client_request_id: CommandId,
        expected_revision: int,
        project: dict[str, Any],
        command_name: str,
        payload: dict[str, Any],
    ) -> ComposeResult:
        """Apply one deterministic command without persisting the draft."""


@dataclass(frozen=True, slots=True)
class AppliedComposeCommand:
    command_id: CommandId
    resulting_revision: int


class ComposeCommandApplier:
    def __init__(
        self,
        repository: DraftRepository,
        compose_client: ComposeClient,
    ) -> None:
        self._repository = repository
        self._compose_client = compose_client

    async def apply(self, command: ComposeCommandInput) -> AppliedComposeCommand:
        draft = await self._repository.get(command.project_id)
        command_state = await self._repository.begin_command(command, draft.revision)
        if command_state.status == "committed":
            if command_state.resulting_revision is None:
                raise ComicServiceError(
                    "COMPOSE_COMMAND_CONFLICT",
                    "committed command has no resulting revision",
                    retryable=False,
                )
            return AppliedComposeCommand(command.command_id, command_state.resulting_revision)

        try:
            composed = await self._call_compose(command, draft)
        except Exception as exc:
            error_code = exc.code if isinstance(exc, ComicServiceError) else "COMPOSE_FAILED"
            await self._repository.fail_command(command.command_id, error_code)
            raise

        resulting_revision = await self._repository.commit_command_cas(
            command_id=command.command_id,
            project_id=command.project_id,
            expected_revision=draft.revision,
            new_project=composed.project,
            new_content_hash=composed.content_hash,
        )
        return AppliedComposeCommand(command.command_id, resulting_revision)

    async def _call_compose(
        self,
        command: ComposeCommandInput,
        draft: DraftRecord,
    ) -> ComposeResult:
        return await self._compose_client.apply(
            client_request_id=command.command_id,
            expected_revision=draft.revision,
            project=draft.project,
            command_name=command.name,
            payload=command.payload,
        )
