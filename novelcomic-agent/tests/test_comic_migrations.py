"""Migration scripts stay ordered and self-contained without a database."""

from __future__ import annotations

import inspect

import pytest

from novelcomic_agent.comic.persistence.ledger import LedgerSession
from novelcomic_agent.comic.persistence.memory import MemorySession
from novelcomic_agent.comic.persistence.migrate import migration_statements


def test_migrations_are_ordered_and_transaction_boundaries_are_stripped() -> None:
    loaded = migration_statements()
    assert [name for name, _statements in loaded] == [
        "0001_initial.sql",
        "0002_stage_b.sql",
        "0003_stage_e_ledger.sql",
    ]
    initial = loaded[0][1]
    assert initial
    assert all(not item.lstrip().upper().startswith("BEGIN") for item in initial)
    assert all(item.split(None, 1)[0].upper() != "COMMIT" for item in initial)
    assert any(item.startswith("CREATE TABLE productions") for item in initial)
    stage_e = loaded[2][1]
    assert any(item.startswith("CREATE TABLE deliveries") for item in stage_e)
    assert any(item.startswith("CREATE TABLE object_tombstones") for item in stage_e)
    assert any(item.startswith("CREATE TABLE alerts") for item in stage_e)
    deferred = [item for item in stage_e if "DEFERRABLE" in item]
    assert len(deferred) == 1
    assert deferred[0].lstrip().startswith("DO")


def test_memory_session_covers_the_ledger_protocol() -> None:
    missing = _methods(LedgerSession) - _methods(MemorySession)
    assert missing == set()


def test_postgres_session_covers_the_ledger_protocol() -> None:
    pytest.importorskip("asyncpg")
    from novelcomic_agent.comic.persistence.postgres import PostgresSession

    missing = _methods(LedgerSession) - _methods(PostgresSession)
    assert missing == set()


def _methods(cls: type) -> set[str]:
    return {
        name
        for name, value in cls.__dict__.items()
        if not name.startswith("_") and inspect.isfunction(value)
    }
