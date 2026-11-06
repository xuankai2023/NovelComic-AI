"""Stable business identifiers for comic production."""

from __future__ import annotations

import hashlib
from typing import Annotated

from pydantic import StringConstraints, TypeAdapter

PageId = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
ProductionId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
ProjectId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
ArtifactId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
CommandId = Annotated[str, StringConstraints(pattern=r"^compose:.+")]
StableLineKey = Annotated[
    str,
    StringConstraints(pattern=r"^line:[a-f0-9]{64}:\d+:\d+:\d+$"),
]
ShotId = Annotated[
    str,
    StringConstraints(pattern=r"^shot:[a-f0-9]{64}:\d+:part:\d+$"),
]
LineId = StableLineKey
SpeakerId = Annotated[
    str,
    StringConstraints(pattern=r"^speaker:(unknown|[a-f0-9]{64}:\d+)$"),
]

_page_id_adapter = TypeAdapter(PageId)
_stable_line_key_adapter = TypeAdapter(StableLineKey)
_shot_id_adapter = TypeAdapter(ShotId)


def page_id_from_bytes(source: bytes) -> PageId:
    """Derive content identity from the immutable source bytes."""

    return _page_id_adapter.validate_python(hashlib.sha256(source).hexdigest())


def make_stable_line_key(
    page_id: PageId,
    panel_reading_order: int,
    bubble_reading_order: int,
    clause_index: int,
) -> StableLineKey:
    """Build a line key that remains stable when a panel is split into shots."""

    positions = (panel_reading_order, bubble_reading_order, clause_index)
    if any(position < 0 for position in positions):
        raise ValueError("line positions must be non-negative")
    value = f"line:{page_id}:{panel_reading_order}:{bubble_reading_order}:{clause_index}"
    return _stable_line_key_adapter.validate_python(value)


def make_shot_id(page_id: PageId, reading_order: int, panel_part_index: int) -> ShotId:
    """Build a stable shot identifier from page order and panel part."""

    if reading_order < 0 or panel_part_index < 0:
        raise ValueError("shot positions must be non-negative")
    return _shot_id_adapter.validate_python(
        f"shot:{page_id}:{reading_order}:part:{panel_part_index}"
    )
