"""Compose replay, commit crash, revision conflict, and ledger rollback."""

from __future__ import annotations

import pytest

from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.drafts.apply_compose_command import ComposeCommandApplier
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.persistence.rows import OutboxRow, utcnow
from novelcomic_agent.comic.rendering.commands import compose_command
from novelcomic_agent.comic.repositories.draft_repository import LedgerDraftRepository
from novelcomic_agent.comic.repositories.production_repository import ProductionRepository
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import ScriptedRemotion, empty_project, production_request


async def _draft() -> tuple[LedgerDraftRepository, ScriptedRemotion, str, ProductionRepository]:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    project = empty_project()
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(request_id="compose"),
        project=project,
        content_hash=project_content_hash(project),
        production_id="prod_compose",
        project_id="prj_compose",
    )
    drafts = LedgerDraftRepository(ledger)
    return drafts, ScriptedRemotion(), accepted.project_id, productions


async def test_replaying_a_compose_command_does_not_bump_revision() -> None:
    drafts, remotion, project_id, _productions = await _draft()
    applier = ComposeCommandApplier(drafts, remotion)
    command = compose_command(project_id, "shot/edit", {"shotId": "shot-a", "seed": 1})
    first = await applier.apply(command)
    second = await applier.apply(command)
    assert first.resulting_revision == second.resulting_revision == 1
    assert remotion.apply_calls == ["shot/edit"]
    assert (await drafts.get(project_id)).revision == 1


async def test_crash_after_compose_retries_once() -> None:
    drafts, remotion, project_id, _productions = await _draft()

    class CrashOnce:
        def __init__(self, inner: LedgerDraftRepository) -> None:
            self._inner = inner
            self.crash = True

        def __getattr__(self, name: str):
            return getattr(self._inner, name)

        async def commit_command_cas(self, **kwargs):
            if self.crash:
                self.crash = False
                raise RuntimeError("commit crashed")
            return await self._inner.commit_command_cas(**kwargs)

    applier = ComposeCommandApplier(CrashOnce(drafts), remotion)  # type: ignore[arg-type]
    command = compose_command(project_id, "shot/edit", {"shotId": "shot-a", "seed": 2})
    with pytest.raises(RuntimeError, match="commit crashed"):
        await applier.apply(command)
    assert (await drafts.get(project_id)).revision == 0
    recovered = await applier.apply(command)
    replayed = await applier.apply(command)
    assert recovered.resulting_revision == replayed.resulting_revision == 1
    assert remotion.apply_calls == ["shot/edit", "shot/edit"]


async def test_stale_cas_keeps_the_committed_revision() -> None:
    drafts, remotion, project_id, _productions = await _draft()
    applier = ComposeCommandApplier(drafts, remotion)
    first = compose_command(project_id, "shot/edit", {"shotId": "shot-a", "seed": 3})
    await applier.apply(first)
    second = compose_command(project_id, "shot/edit", {"shotId": "shot-b", "seed": 4})
    await drafts.begin_command(second, 0)
    with pytest.raises(ComicServiceError) as caught:
        await drafts.commit_command_cas(
            command_id=second.command_id,
            project_id=project_id,
            expected_revision=0,
            new_project=empty_project(),
            new_content_hash=project_content_hash(empty_project()),
        )
    assert caught.value.code == "DRAFT_REVISION_CONFLICT"
    assert (await drafts.get(project_id)).revision == 1
    recovered = await applier.apply(second)
    assert recovered.resulting_revision == 2


async def test_state_and_outbox_roll_back_together() -> None:
    ledger = MemoryLedger()
    productions = ProductionRepository(ledger)
    project = empty_project()
    accepted = await productions.accept(
        tenant_id="tenant-a",
        request=production_request(request_id="rollback"),
        project=project,
        content_hash=project_content_hash(project),
        production_id="prod_rollback",
        project_id="prj_rollback",
    )
    before = await productions.list_outbox(accepted.production_id)
    with pytest.raises(RuntimeError, match="boom"):
        async with ledger.transaction() as session:
            row = await session.get_production(accepted.production_id)
            row.state = ProductionState.DELIVERED.value
            await session.save_production(row, expected_version=row.version)
            now = utcnow()
            await session.insert_outbox(
                OutboxRow(
                    event_id="evt-boom",
                    aggregate_id=accepted.production_id,
                    type="production.state.changed",
                    payload={"state": "DELIVERED"},
                    available_at=now,
                    published_at=None,
                    attempt=0,
                    lease_owner=None,
                    lease_expires_at=None,
                    created_at=now,
                )
            )
            raise RuntimeError("boom")
    row = await productions.get_row(accepted.production_id)
    assert row.state == ProductionState.CREATED.value
    assert row.version == 0
    events = await productions.list_outbox(accepted.production_id)
    assert [event.event_id for event in events] == [event.event_id for event in before]
