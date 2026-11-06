"""Reject preview, review, and delivery work that is not the current draft."""

from __future__ import annotations

from ..contracts.errors import ComicServiceError
from ..drafts.draft_repository import DraftRecord


def require_draft_binding(
    draft: DraftRecord,
    *,
    revision: int,
    content_hash: str,
) -> None:
    if draft.revision != revision or draft.content_hash != content_hash:
        raise ComicServiceError(
            "DRAFT_REVISION_CONFLICT",
            "result is not bound to the committed draft",
            retryable=False,
            details={"revision": draft.revision, "contentHash": draft.content_hash},
        )
