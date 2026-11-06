"""Apply comic SQL migrations once, in filename order."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_MIGRATION_DIR = Path(__file__).resolve().parents[1] / "drafts" / "migrations"
_MIGRATION_FILES = (
    "0001_initial.sql",
    "0002_stage_b.sql",
    "0003_stage_e_ledger.sql",
    "0004_l0_panel_stage.sql",
)
_MIGRATION_LOCK = 83427591
_DOLLAR = re.compile(r"\$[A-Za-z0-9_]*\$")
_TX_BOUNDARY = {"BEGIN", "COMMIT", "ROLLBACK", "END"}


def migration_statements() -> list[tuple[str, list[str]]]:
    """Return each shipped migration as statements with its own transaction boundaries removed."""

    loaded: list[tuple[str, list[str]]] = []
    for name in _MIGRATION_FILES:
        text = (_MIGRATION_DIR / name).read_text(encoding="utf-8")
        loaded.append((name, split_sql(text)))
    return loaded


def split_sql(sql: str) -> list[str]:
    """Split a migration script on semicolons that are outside quotes and dollar blocks."""

    statements: list[str] = []
    buf: list[str] = []
    index = 0
    in_single = False
    dollar: str | None = None
    length = len(sql)
    while index < length:
        if dollar is None and not in_single and sql.startswith("--", index):
            newline = sql.find("\n", index)
            index = length if newline < 0 else newline + 1
            continue
        if dollar is not None:
            if sql.startswith(dollar, index):
                buf.append(dollar)
                index += len(dollar)
                dollar = None
            else:
                buf.append(sql[index])
                index += 1
            continue
        if in_single:
            buf.append(sql[index])
            if sql[index] == "'":
                if index + 1 < length and sql[index + 1] == "'":
                    buf.append("'")
                    index += 2
                    continue
                in_single = False
            index += 1
            continue
        if sql[index] == "'":
            in_single = True
            buf.append("'")
            index += 1
            continue
        if sql[index] == "$":
            match = _DOLLAR.match(sql, index)
            if match is not None:
                tag = match.group(0)
                dollar = tag
                buf.append(tag)
                index += len(tag)
                continue
        if sql[index] == ";":
            _store(statements, "".join(buf))
            buf = []
            index += 1
            continue
        buf.append(sql[index])
        index += 1
    _store(statements, "".join(buf))
    return statements


async def apply_migrations(pool: Any) -> list[str]:
    """Run migrations that are not yet recorded in schema_migrations."""

    async with pool.acquire() as conn:
        await conn.execute("SELECT pg_advisory_lock($1)", _MIGRATION_LOCK)
        try:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                  version text PRIMARY KEY,
                  applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
            recorded = {
                row["version"] for row in await conn.fetch("SELECT version FROM schema_migrations")
            }
            applied: list[str] = []
            for version, statements in migration_statements():
                if version in recorded:
                    continue
                async with conn.transaction():
                    for statement in statements:
                        await conn.execute(statement)
                    await conn.execute(
                        "INSERT INTO schema_migrations (version) VALUES ($1)",
                        version,
                    )
                applied.append(version)
            return applied
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", _MIGRATION_LOCK)


def _store(statements: list[str], raw: str) -> None:
    text = raw.strip()
    if not text:
        return
    head = text.split(None, 1)[0].upper()
    if head in _TX_BOUNDARY:
        return
    statements.append(text)
