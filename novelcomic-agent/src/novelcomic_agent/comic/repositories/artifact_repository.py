"""Artifact claim, tenant reuse, and checksum-gated completion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..persistence.ledger import Ledger, LedgerSession
from ..persistence.rows import ArtifactRow, utcnow


@dataclass(frozen=True, slots=True)
class ArtifactClaim:
    artifact: ArtifactRow
    reused: bool
    start_work: bool
    exhausted: bool = False


class ArtifactRepository:
    """One row per project, stage, input hash, and optional shot."""

    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def claim(
        self,
        *,
        tenant_id: str,
        project_id: str,
        stage: str,
        input_hash: str,
        artifact_id: str,
        provider: str,
        shot_id: str | None = None,
        max_attempts: int = 2,
    ) -> ArtifactClaim:
        now = utcnow()
        async with self._ledger.transaction() as session:
            own = await session.find_artifact(
                project_id=project_id,
                stage=stage,
                input_hash=input_hash,
                shot_id=shot_id,
            )
            if own is not None and own.tenant_id != tenant_id:
                own = None
            if own is not None and own.status == "completed":
                return ArtifactClaim(own, reused=True, start_work=False)
            if own is not None and own.status == "running":
                return ArtifactClaim(own, reused=False, start_work=False)
            if own is not None and own.status == "failed":
                if own.attempt >= max_attempts:
                    return ArtifactClaim(own, reused=False, start_work=False, exhausted=True)
                own.status = "running"
                own.attempt += 1
                own.updated_at = now
                await session.save_artifact(own)
                return ArtifactClaim(own, reused=False, start_work=True)
            shared = await session.find_tenant_artifact(
                tenant_id=tenant_id,
                stage=stage,
                input_hash=input_hash,
            )
            if shared is not None:
                clone = ArtifactRow(
                    artifact_id=artifact_id,
                    tenant_id=tenant_id,
                    project_id=project_id,
                    shot_id=shot_id,
                    stage=stage,
                    input_hash=input_hash,
                    provider=shared.provider,
                    provider_request_id=None,
                    status="completed",
                    urls=list(shared.urls),
                    checksums=list(shared.checksums),
                    diagnostics={**shared.diagnostics, "reusedFrom": shared.artifact_id},
                    cost_fen=0,
                    attempt=shared.attempt,
                    created_at=now,
                    updated_at=now,
                )
                await session.insert_artifact(clone)
                return ArtifactClaim(clone, reused=True, start_work=False)
            created = ArtifactRow(
                artifact_id=artifact_id,
                tenant_id=tenant_id,
                project_id=project_id,
                shot_id=shot_id,
                stage=stage,
                input_hash=input_hash,
                provider=provider,
                provider_request_id=None,
                status="running",
                urls=[],
                checksums=[],
                diagnostics={},
                cost_fen=0,
                attempt=1,
                created_at=now,
                updated_at=now,
            )
            await session.insert_artifact(created)
            return ArtifactClaim(created, reused=False, start_work=True)

    async def list_project(self, project_id: str) -> list[ArtifactRow]:
        async with self._ledger.transaction() as session:
            return await session.list_artifacts(project_id)

    async def get(self, artifact_id: str) -> ArtifactRow | None:
        async with self._ledger.transaction() as session:
            return await session.get_artifact(artifact_id)

    async def update_diagnostics(
        self,
        artifact_id: str,
        diagnostics: dict[str, Any],
    ) -> ArtifactRow:
        async with self._ledger.transaction() as session:
            row = await session.get_artifact(artifact_id)
            if row is None:
                raise KeyError(artifact_id)
            row.diagnostics = {**row.diagnostics, **diagnostics}
            await session.save_artifact(row)
            return row

    async def attach_provider_request(
        self,
        artifact_id: str,
        provider_request_id: str,
    ) -> ArtifactRow:
        async with self._ledger.transaction() as session:
            row = await self._running(session, artifact_id)
            row.provider_request_id = provider_request_id
            await session.save_artifact(row)
            return row

    async def complete(
        self,
        artifact_id: str,
        *,
        urls: list[str],
        checksums: list[str],
        diagnostics: dict[str, Any],
        cost_fen: int,
        provider_request_id: str | None = None,
    ) -> ArtifactRow:
        if not checksums or len(checksums) != len(urls):
            raise ValueError("a completed artifact requires one checksum per url")
        async with self._ledger.transaction() as session:
            row = await session.get_artifact(artifact_id)
            if row is None:
                raise KeyError(artifact_id)
            if row.status == "completed":
                if row.checksums == checksums and row.urls == urls:
                    return row
                raise ValueError("completed artifact checksum does not match")
            if row.status != "running":
                raise ValueError("only a running artifact can be completed")
            row.status = "completed"
            row.urls = list(urls)
            row.checksums = list(checksums)
            row.diagnostics = diagnostics
            row.cost_fen = cost_fen
            if provider_request_id:
                row.provider_request_id = provider_request_id
            await session.save_artifact(row)
            return row

    async def fail(
        self,
        artifact_id: str,
        *,
        diagnostics: dict[str, Any],
    ) -> ArtifactRow | None:
        async with self._ledger.transaction() as session:
            row = await session.get_artifact(artifact_id)
            if row is None or row.status == "completed":
                return row
            row.status = "failed"
            row.diagnostics = diagnostics
            await session.save_artifact(row)
            return row

    async def _running(self, session: LedgerSession, artifact_id: str) -> ArtifactRow:
        row = await session.get_artifact(artifact_id)
        if row is None or row.status not in {"running", "failed"}:
            raise ValueError("artifact is not open")
        if row.status == "failed":
            row.status = "running"
        return row
