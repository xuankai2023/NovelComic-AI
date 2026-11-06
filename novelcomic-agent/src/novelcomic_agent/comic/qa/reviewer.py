"""Merge model and rule findings. This module does not compose or advance state."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..contracts.errors import ComicServiceError
from ..contracts.review import ReviewEvidence, ReviewIssue, ReviewReport

REVIEWER_VERSION = "reviewer-v1"
RULE_VERSION = "stage-e-rules-v1"
_MIN_CONFIDENCE = 0.8


@dataclass(frozen=True, slots=True)
class ReviewRequest:
    content_hash: str
    draft_content_hash: str
    frames: tuple[dict[str, object], ...]
    summary: dict[str, object]
    still_keys: tuple[str, ...]
    lowres_key: str | None


class ReviewProvider(Protocol):
    async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
        """Return raw findings. The reviewer decides which ones may be fixed."""


class EmptyReviewProvider:
    async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
        del request
        return []


class Reviewer:
    def __init__(
        self,
        provider: ReviewProvider | None = None,
        *,
        min_confidence: float = _MIN_CONFIDENCE,
    ) -> None:
        self._provider = provider or EmptyReviewProvider()
        self._min_confidence = min_confidence

    async def review(self, request: ReviewRequest) -> ReviewReport:
        if request.content_hash != request.draft_content_hash:
            return ReviewReport(
                content_hash=request.draft_content_hash,
                reviewer_version=REVIEWER_VERSION,
                rule_version=RULE_VERSION,
                issues=[
                    ReviewIssue(
                        code="PREVIEW_STALE",
                        severity="warning",
                        message="preview artifacts are bound to an older draft",
                        confidence=1,
                        actionable=False,
                    )
                ],
                stale=True,
            )
        try:
            raw = await self._provider.review(request)
        except ComicServiceError:
            raise
        except Exception as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "reviewer unavailable",
                retryable=True,
            ) from exc
        issues = [_gate(issue, self._min_confidence) for issue in raw]
        return ReviewReport(
            content_hash=request.draft_content_hash,
            reviewer_version=REVIEWER_VERSION,
            rule_version=RULE_VERSION,
            issues=_merge(issues),
        )


def _gate(issue: ReviewIssue, min_confidence: float) -> ReviewIssue:
    evidence = list(issue.evidence)
    same_shot = _evidence_matches_shot(issue.shot_id, evidence)
    actionable = bool(evidence) and issue.confidence >= min_confidence and same_shot
    return issue.model_copy(update={"evidence": evidence, "actionable": actionable})


def _evidence_matches_shot(shot_id: str | None, evidence: list[ReviewEvidence]) -> bool:
    shot_ids = {item.shot_id for item in evidence if item.shot_id}
    if shot_id is None:
        return len(shot_ids) <= 1
    if not shot_ids:
        return True
    return shot_ids == {shot_id}


def _merge(issues: list[ReviewIssue]) -> list[ReviewIssue]:
    merged: dict[tuple[str, str, str], ReviewIssue] = {}
    order: list[tuple[str, str, str]] = []
    for issue in issues:
        key = (issue.code, issue.shot_id or "", issue.suggested_action or "")
        current = merged.get(key)
        if current is None:
            merged[key] = issue
            order.append(key)
            continue
        evidence = [*current.evidence, *issue.evidence]
        merged[key] = current.model_copy(
            update={
                "evidence": evidence,
                "confidence": max(current.confidence, issue.confidence),
                "actionable": current.actionable or issue.actionable,
                "message": current.message or issue.message,
                "parameters": {**issue.parameters, **current.parameters},
            }
        )
    order.sort()
    return [merged[key] for key in order]
