"""Database lease boundary for idempotent RabbitMQ consumers."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class WorkerJob:
    job_key: str
    type: str
    payload: dict[str, Any]
    attempt: int
    lease_owner: str
    lease_expires_at: datetime


class JobLeaseRepository(Protocol):
    async def claim(
        self,
        *,
        job_type: str,
        owner: str,
        lease_seconds: int,
    ) -> WorkerJob | None:
        """Atomically claim one available job with skip-locked semantics."""

    async def heartbeat(
        self,
        *,
        job_key: str,
        owner: str,
        lease_seconds: int,
    ) -> bool:
        """Extend a live lease only for its current owner."""

    async def complete(self, *, job_key: str, owner: str) -> bool:
        """Commit successful completion only for the current owner."""

    async def fail(self, *, job_key: str, owner: str, error_code: str) -> bool:
        """Commit failure only for the current owner."""
