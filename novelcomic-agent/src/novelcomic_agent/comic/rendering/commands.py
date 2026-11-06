"""Deterministic Compose command identities."""

from __future__ import annotations

import hashlib
from typing import Any

from ..canonical import hash_content
from ..contracts.compose_command import ComposeCommandInput


def compose_command(project_id: str, name: str, payload: dict[str, Any]) -> ComposeCommandInput:
    """Build a command whose id and ordinal stay fixed when the payload is replayed."""

    input_hash = hash_content(payload)
    ordinal = int.from_bytes(
        hashlib.sha256(f"{name}:{input_hash}".encode()).digest()[:4],
        "big",
    ) & 0x7FFFFFFF
    if ordinal == 0:
        ordinal = 1
    return ComposeCommandInput(
        command_id=f"compose:{project_id}:{name}:{ordinal}",
        project_id=project_id,
        ordinal=ordinal,
        name=name,
        input_hash=input_hash,
        payload=payload,
    )
