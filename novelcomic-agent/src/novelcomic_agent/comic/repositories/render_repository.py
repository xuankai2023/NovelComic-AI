"""Output-batch persistence. A batch with a render id is polled, not resubmitted."""

from __future__ import annotations

from typing import Any

from ..persistence.ledger import Ledger
from ..persistence.memory import UniqueViolation
from ..persistence.rows import BatchRow, utcnow


class RenderRepository:
    def __init__(self, ledger: Ledger) -> None:
        self._ledger = ledger

    async def save_planned(self, row: BatchRow) -> BatchRow:
        try:
            async with self._ledger.transaction() as session:
                existing = await session.find_batch(
                    project_id=row.project_id,
                    batch_id=row.batch_id,
                    content_hash=row.content_hash,
                )
                if existing is not None:
                    return existing
                await session.insert_batch(row)
                return row
        except UniqueViolation:
            async with self._ledger.transaction() as session:
                winner = await session.find_batch(
                    project_id=row.project_id,
                    batch_id=row.batch_id,
                    content_hash=row.content_hash,
                )
            if winner is None:
                raise
            return winner

    async def list_for_hash(self, project_id: str, content_hash: str) -> list[BatchRow]:
        async with self._ledger.transaction() as session:
            return await session.list_batches(project_id, content_hash)

    async def list_all(self, project_id: str) -> list[BatchRow]:
        async with self._ledger.transaction() as session:
            return await session.list_batches(project_id)

    async def mark_submitted(
        self,
        output_batch_render_id: str,
        *,
        render_id: str,
        bucket_name: str,
    ) -> BatchRow | None:
        """Return None when the batch already has a render id and must only be polled."""

        async with self._ledger.transaction() as session:
            row = await session.get_batch(output_batch_render_id)
            if row is None:
                raise KeyError(output_batch_render_id)
            if row.render_id:
                return None
            if row.status not in {"pending", "failed"}:
                return None
            row.render_id = render_id
            row.bucket_name = bucket_name
            row.status = "submitted"
            row.attempt += 1
            row.updated_at = utcnow()
            await session.save_batch(row)
            return row

    async def save_progress(
        self,
        output_batch_render_id: str,
        *,
        progress: float,
        status: str,
    ) -> BatchRow:
        async with self._ledger.transaction() as session:
            row = await self._require(session, output_batch_render_id)
            row.progress = progress
            row.status = status
            await session.save_batch(row)
            return row

    async def mark_failed(self, output_batch_render_id: str) -> BatchRow:
        async with self._ledger.transaction() as session:
            row = await self._require(session, output_batch_render_id)
            row.status = "failed"
            row.render_id = None
            row.bucket_name = None
            await session.save_batch(row)
            return row

    async def mark_completed(
        self,
        output_batch_render_id: str,
        *,
        url: str,
        checksum: str,
        object_key: str,
    ) -> BatchRow:
        if not checksum:
            raise ValueError("render completion requires a checksum")
        async with self._ledger.transaction() as session:
            row = await self._require(session, output_batch_render_id)
            if row.status == "completed" and row.checksum == checksum:
                return row
            row.status = "completed"
            row.url = url
            row.checksum = checksum
            row.object_key = object_key
            row.progress = 1
            await session.save_batch(row)
            return row

    async def cancel_other_hashes(self, project_id: str, content_hash: str) -> None:
        async with self._ledger.transaction() as session:
            rows = await session.list_batches(project_id)
            for row in rows:
                if row.content_hash == content_hash or row.status == "cancelled":
                    continue
                row.status = "cancelled"
                await session.save_batch(row)

    async def required_complete(self, project_id: str, content_hash: str) -> bool:
        rows = await self.list_for_hash(project_id, content_hash)
        required = [row for row in rows if row.required]
        if not required:
            return False
        return all(row.status == "completed" and row.checksum for row in required)

    async def _require(self, session: Any, output_batch_render_id: str) -> BatchRow:
        row = await session.get_batch(output_batch_render_id)
        if row is None:
            raise KeyError(output_batch_render_id)
        return row
