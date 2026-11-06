"""Stage E reviews one draft, fixes at most once, and packages without rendering again."""

from __future__ import annotations

import hashlib
import zipfile
from datetime import UTC, datetime, timedelta
from io import BytesIO
from typing import Any

import pytest

from novelcomic_agent.comic.contracts.delivery_manifest import (
    DeliveryFileEntry,
    DeliveryPackageManifest,
    OutputBatch,
)
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.contracts.review import ReviewEvidence, ReviewIssue, ReviewReport
from novelcomic_agent.comic.delivery.manifest_builder import blocking_reason, package_input_hash
from novelcomic_agent.comic.delivery.package_builder import PackageBuilder, safe_zip_path
from novelcomic_agent.comic.operations.alerting import AlertFact
from novelcomic_agent.comic.operations.tenant_policy import (
    AuthContext,
    QuotaFacts,
    TenantDirectory,
    evaluate,
    may_cancel,
)
from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.qa.contact_sheet import (
    assemble_contact_sheet,
    decode_png,
    encode_png,
    write_preview_avi,
)
from novelcomic_agent.comic.qa.fix_policy import FixPolicy
from novelcomic_agent.comic.qa.reviewer import (
    REVIEWER_VERSION,
    RULE_VERSION,
    Reviewer,
    ReviewRequest,
)
from novelcomic_agent.comic.rendering.commands import compose_command
from novelcomic_agent.comic.repositories.delivery_repository import DeliveryRepository
from novelcomic_agent.comic.stage_e import build_stage_e
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.workflow.production_states import TERMINAL_STATES, ProductionState
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    page_png,
    production_request,
    tenant_from_header,
)

HOSTS = frozenset({"cdn.example", "objects.novelcomic.local"})
PAGE = "ab" * 32
SHOT = f"shot:{PAGE}:0:part:0"


class Channel:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.fail = False

    async def publish(self, body: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("channel down")
        self.messages.append(body)

    async def resolve(self, dedup_key: str) -> None:
        if self.fail:
            raise RuntimeError("channel down")
        self.messages.append({"resolve": dedup_key})


class DurationFindings:
    async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
        frame = request.frames[0]
        shot_id = str(frame["shotId"])
        return [
            ReviewIssue(
                code="SHOT_TOO_SHORT",
                severity="warning",
                shot_id=shot_id,
                evidence=[
                    ReviewEvidence(
                        kind="still",
                        shot_id=shot_id,
                        frame=int(frame["frame"]),
                        detail="held",
                    )
                ],
                suggested_action="adjust-shot-duration",
                confidence=0.95,
                message="shot is short",
                parameters={"durationInFrames": 400},
            )
        ]


class Boom:
    async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
        del request
        raise RuntimeError("provider down")


class Quiet:
    def __init__(self) -> None:
        self.calls = 0

    async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
        del request
        self.calls += 1
        return []


def _runtime(
    remotion: ScriptedRemotion | None = None,
    *,
    provider: Any = None,
    directory: TenantDirectory | None = None,
    objects: MemoryObjectStore | None = None,
    channel: Channel | None = None,
):
    images = {"https://cdn.example/page-1.png": page_png("page-body")}
    return build_stage_e(
        ledger=MemoryLedger(),
        remotion=remotion or ScriptedRemotion(),
        objects=objects or MemoryObjectStore(),
        detector=ScriptedDetector(),
        speech=ScriptedSpeech(),
        fetcher=MemoryFetcher(images),
        allowed_hosts=HOSTS,
        authenticate=tenant_from_header,
        directory=directory or TenantDirectory(known_tenants=frozenset({"tenant-a"})),
        alert_channel=channel or Channel(),
        review_provider=provider,
    )


async def _drive(runtime: Any, production_id: str, *, stop_at: ProductionState | None = None):
    await runtime.analyze.run(production_id)
    await runtime.voice.run(production_id)
    for _ in range(10):
        row = await runtime.productions.get_row(production_id)
        state = ProductionState(row.state)
        if state in TERMINAL_STATES or state is stop_at:
            return row
        if state in {ProductionState.PREVIEWING, ProductionState.REVIEWING, ProductionState.FIXING}:
            await runtime.preview.run(production_id)
        else:
            await runtime.render.run(production_id)
    return await runtime.productions.get_row(production_id)


def _project(level: str = "L0") -> dict[str, Any]:
    tracks: list[dict[str, Any]] = [
        {"id": f"track:{SHOT}:panel", "shotId": SHOT, "semantic": "background", "hidden": False}
    ]
    if level in {"L1", "L2"}:
        tracks.append(
            {"id": f"track:{SHOT}:head", "shotId": SHOT, "semantic": "head", "hidden": False}
        )
    if level == "L2":
        tracks.append(
            {"id": f"track:{SHOT}:eye", "shotId": SHOT, "semantic": "eye-open", "hidden": False}
        )
    return {
        "fps": 30,
        "shots": [{"id": SHOT, "from": 0, "durationInFrames": 20}],
        "tracks": tracks,
        "items": {
            f"item:{SHOT}:panel": {"id": f"item:{SHOT}:panel"},
            f"item:{SHOT}:head": {"id": f"item:{SHOT}:head"},
            "cap-1": {
                "id": "cap-1",
                "type": "captions",
                "shotId": SHOT,
                "text": "original line",
                "from": 0,
                "durationInFrames": 10,
                "visible": False,
            },
        },
        "assets": {f"asset:{SHOT}:panel": {"id": f"asset:{SHOT}:panel"}},
    }


def _report(
    issues: list[ReviewIssue], *, content_hash: str = "ab" * 32, stale: bool = False
) -> ReviewReport:
    return ReviewReport(
        content_hash=content_hash,
        reviewer_version=REVIEWER_VERSION,
        rule_version=RULE_VERSION,
        issues=issues,
        stale=stale,
    )


def _issue(**overrides: Any) -> ReviewIssue:
    values: dict[str, Any] = {
        "code": "SHOT_TOO_SHORT",
        "severity": "warning",
        "shot_id": SHOT,
        "evidence": [ReviewEvidence(kind="still", shot_id=SHOT, frame=1, detail="held")],
        "suggested_action": "adjust-shot-duration",
        "confidence": 0.95,
        "message": "short",
        "parameters": {"durationInFrames": 100},
        "actionable": True,
    }
    values.update(overrides)
    return ReviewIssue(**values)


async def test_reviewer_gates_empty_duplicates_cross_shot_stale_and_provider_failure() -> None:
    quiet = Quiet()
    reviewer = Reviewer(quiet)
    request = ReviewRequest("ab" * 32, "ab" * 32, (), {}, (), None)
    empty = await reviewer.review(request)
    assert empty.issues == []
    assert quiet.calls == 1

    class Dupes:
        async def review(self, request: ReviewRequest) -> list[ReviewIssue]:
            del request
            return [
                _issue(message="one"),
                _issue(message="two", confidence=0.99),
                _issue(
                    evidence=[ReviewEvidence(kind="still", shot_id="shot:other", frame=2)],
                    code="OTHER",
                    suggested_action="set-camera-preset",
                ),
                _issue(confidence=0.2, code="LOW"),
            ]

    report = await Reviewer(Dupes()).review(request)
    assert len(report.issues) == 3
    assert report.reviewer_version == REVIEWER_VERSION
    merged = next(issue for issue in report.issues if issue.code == "SHOT_TOO_SHORT")
    assert merged.actionable is True
    assert len(merged.evidence) == 2
    crossed = next(issue for issue in report.issues if issue.code == "OTHER")
    assert crossed.actionable is False
    low = next(issue for issue in report.issues if issue.code == "LOW")
    assert low.actionable is False

    stale_provider = Quiet()
    stale = await Reviewer(stale_provider).review(
        ReviewRequest("aa" * 32, "bb" * 32, (), {}, (), None)
    )
    assert stale.stale is True
    assert stale_provider.calls == 0
    with pytest.raises(ComicServiceError, match="reviewer unavailable"):
        await Reviewer(Boom()).review(request)


def test_fix_policy_allows_one_whitelist_round() -> None:
    policy = FixPolicy()
    project = _project("L1")
    approved = policy.decide(
        report=_report([_issue()]),
        project=project,
        project_id="project-1",
        revision=3,
        fixing_count=0,
    )
    assert approved.decision == "approved"
    assert approved.estimated_cost_fen == 0
    assert approved.commands[0].name == "shot/edit"
    assert approved.commands[0].payload["durationInFrames"] == 50
    assert approved.expected_revision == 3

    limited = policy.decide(
        report=_report([_issue()]),
        project=project,
        project_id="project-1",
        revision=4,
        fixing_count=1,
    )
    assert limited.reason == "fixing-limit"
    assert limited.commands == []

    unsafe = policy.decide(
        report=_report([_issue(parameters={"durationInFrames": 30, "url": "https://evil.example/a"})]),
        project=project,
        project_id="project-1",
        revision=3,
        fixing_count=0,
    )
    assert unsafe.reason == "unsafe-command"

    downgrade = policy.decide(
        report=_report([_issue(code="QUALITY", suggested_action="downgrade-level", parameters={})]),
        project=project,
        project_id="project-1",
        revision=3,
        fixing_count=0,
    )
    assert downgrade.commands[0].name == "layers/restore-l0"
    skipped = policy.decide(
        report=_report([_issue(code="QUALITY", suggested_action="downgrade-level", parameters={})]),
        project=_project("L2"),
        project_id="project-1",
        revision=3,
        fixing_count=0,
    )
    assert skipped.reason == "downgrade-step-unavailable"

    restored = policy.decide(
        report=_report(
            [
                _issue(
                    code="SUBTITLE",
                    suggested_action="restore-subtitle-visibility",
                    parameters={"text": "HACKED"},
                )
            ]
        ),
        project=project,
        project_id="project-1",
        revision=3,
        fixing_count=0,
    )
    assert restored.commands[0].payload["lines"][0]["text"] == "original line"
    assert "HACKED" not in str(restored.commands[0].payload)


def test_manifest_hash_ignores_generated_at_and_blocks_missing_video() -> None:
    manifest = DeliveryPackageManifest(
        project_id="project-1",
        generated_at="2026-01-01T00:00:00+00:00",
        project_content_hash="cd" * 32,
        play_order=["videos/000000-batch.mp4"],
        batches=[
            OutputBatch(
                batch_id="batch",
                batch_index=0,
                from_frame=0,
                end_frame_inclusive=10,
                duration_in_frames=11,
                shot_ids=[SHOT],
                reason="l0",
            )
        ],
        files=[
            DeliveryFileEntry(
                path="videos/000000-batch.mp4",
                category="final-video",
                order=0,
                object_key="tenant/prod/renders/batch",
                checksum="ef" * 32,
                size_bytes=4,
            )
        ],
    )
    later = manifest.model_copy(update={"generated_at": "2026-02-01T00:00:00+00:00"})
    assert package_input_hash(manifest) == package_input_hash(later)
    assert blocking_reason(manifest) is None
    broken = manifest.model_copy(
        update={
            "play_order": [],
            "files": [
                DeliveryFileEntry(
                    path="missing/final-video",
                    category="final-video",
                    order=0,
                    missing_reason="Missing final video",
                )
            ],
        }
    )
    assert blocking_reason(broken) == "required final-video is missing"
    blob = manifest.model_dump_json(by_alias=True)
    assert "expires=" not in blob
    assert "signed." not in blob


def test_package_builder_is_stable_and_rejects_slip_and_oversize() -> None:
    entries = [
        ("project/project.json", b'{"ok":true}'),
        ("play-order.json", b'{"playOrder":[]}'),
        ("videos/000000-batch.mp4", b"mp4"),
        ("manifest.json", b'{"schemaVersion":1}'),
    ]
    builder = PackageBuilder()
    first = builder.build(list(reversed(entries)))
    second = builder.build(entries)
    assert hashlib.sha256(first).hexdigest() == hashlib.sha256(second).hexdigest()
    with zipfile.ZipFile(BytesIO(first)) as archive:
        assert archive.namelist() == [
            "manifest.json",
            "play-order.json",
            "project/project.json",
            "videos/000000-batch.mp4",
        ]
    with pytest.raises(ComicServiceError):
        safe_zip_path("../secret")
    with pytest.raises(ComicServiceError):
        PackageBuilder(max_file_bytes=3).build(entries)


def test_contact_sheet_is_an_image_and_preview_avi_is_stable() -> None:
    still = encode_png(2, 2, bytes((1, 2, 3)) * 4)
    other = encode_png(2, 2, bytes((9, 8, 7)) * 4)
    sheet = assemble_contact_sheet([still, other])
    assert sheet.startswith(b"\x89PNG")
    assert b"shotId" not in sheet
    width, height, rgb = decode_png(sheet)
    assert width > 2 and height == 2 and rgb
    assert write_preview_avi([still, other]) == write_preview_avi([still, other])
    assert write_preview_avi([still]).startswith(b"RIFF")


def test_tenant_policy_rejects_cross_tenant_quota_and_unknown_flags() -> None:
    facts = QuotaFacts(0, 2, 0, 100, 0, 100, frozenset({"preview"}), True)
    known = AuthContext("tenant-a", frozenset({"tenant-a", "tenant-b"}))
    decision = evaluate(known, resource_tenant_id="tenant-b", facts=facts, feature="preview")
    assert decision.reason == (
        "cross-tenant"
    )
    missing = evaluate(
        AuthContext(None, frozenset({"tenant-a"})),
        resource_tenant_id="tenant-a",
        facts=facts,
        feature="preview",
    )
    assert missing.reason == "missing-tenant"
    unknown = evaluate(
        AuthContext("stranger", frozenset({"tenant-a"})),
        resource_tenant_id="stranger",
        facts=facts,
        feature="preview",
    )
    assert unknown.reason == "unknown-tenant"
    busy = QuotaFacts(2, 2, 0, 100, 0, 100, frozenset({"preview"}), True)
    assert evaluate(known, resource_tenant_id="tenant-a", facts=busy, feature="preview").reason == (
        "concurrent-quota"
    )
    decision = evaluate(known, resource_tenant_id="tenant-a", facts=facts, feature="package")
    assert decision.reason == (
        "feature-disabled"
    )
    admin = AuthContext("tenant-a", frozenset({"tenant-a", "tenant-b"}), "admin")
    assert may_cancel(admin, resource_tenant_id="tenant-b").allowed is True
    assert may_cancel(known, resource_tenant_id="tenant-b").reason == "cross-tenant"


async def test_retention_and_alerts_do_not_touch_production_state() -> None:
    moments = [datetime(2026, 1, 1, tzinfo=UTC)]

    def clock() -> datetime:
        return moments[0]

    class CountingStore(MemoryObjectStore):
        def __init__(self) -> None:
            super().__init__()
            self.deletes = 0

        async def delete(self, key: str) -> None:
            self.deletes += 1
            await super().delete(key)

    store = CountingStore()
    await store.put_verified("tenant-a/prod/preview/still", b"still")
    await store.put_verified("tenant-a/prod/preview/held", b"held")
    runtime = _runtime(objects=store)
    runtime.retention._clock = clock
    held = await runtime.retention.request_delete(
        tenant_id="tenant-a",
        object_key="tenant-a/prod/preview/held",
        category="preview",
        delivered=False,
        legal_hold=True,
        referenced_by_active_delivery=False,
    )
    assert held.status == "blocked"
    assert await runtime.retention.execute(held.tombstone_id) is not None
    assert await store.head("tenant-a/prod/preview/held") == len(b"held")

    due = await runtime.retention.request_delete(
        tenant_id="tenant-a",
        object_key="tenant-a/prod/preview/still",
        category="preview",
        delivered=False,
        legal_hold=False,
        referenced_by_active_delivery=False,
    )
    assert due.status == "blocked"
    moments[0] = moments[0] + timedelta(days=2)
    refreshed = await runtime.retention.refresh(
        due.tombstone_id,
        legal_hold=False,
        referenced_by_active_delivery=False,
    )
    assert refreshed is not None and refreshed.status == "pending"
    deleted = await runtime.retention.execute(due.tombstone_id)
    again = await runtime.retention.execute(due.tombstone_id)
    assert deleted is not None and deleted.status == "deleted"
    assert again is not None and again.status == "deleted"
    assert store.deletes == 1
    assert await store.head("tenant-a/prod/preview/still") is None

    channel = Channel()
    accepted = await runtime.service.accept("tenant-a", production_request())
    version = (await runtime.productions.get_row(accepted.production_id)).version
    runtime.alerts._channel = channel
    observed = datetime(2026, 1, 1, 12, 7, tzinfo=UTC)
    fact = AlertFact(
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        stage="PACKAGING",
        error_code="PACKAGE_CORRUPT",
        kind="package-corrupt",
        observed_at=observed,
        details={
            "page": "https://signed.example/file?expires=1&token=abc",
            "text": "full dialogue",
            "project": {"items": {"a": 1}, "shots": []},
        },
    )
    await runtime.alerts.handle(fact)
    await runtime.alerts.handle(fact)
    assert len(channel.messages) == 1
    encoded = str(channel.messages[0])
    assert "expires=" not in encoded
    assert "full dialogue" not in encoded
    assert "token=abc" not in encoded
    channel.fail = True
    failed = await runtime.alerts.handle(
        AlertFact(
            tenant_id="tenant-a",
            production_id=accepted.production_id,
            stage="RENDERING_BATCHES",
            error_code="RENDER_STUCK",
            kind="render-stuck",
            observed_at=observed,
        )
    )
    assert failed.status == "channel_failed"
    assert (await runtime.productions.get_row(accepted.production_id)).version == version


async def test_one_fix_round_then_package_is_tenant_scoped() -> None:
    remotion = ScriptedRemotion()
    runtime = _runtime(remotion, provider=DurationFindings())
    accepted = await runtime.service.accept("tenant-a", production_request())
    row = await _drive(runtime, accepted.production_id, stop_at=ProductionState.PACKAGING)
    assert row.state == ProductionState.PACKAGING.value
    assert remotion.apply_calls.count("shot/edit") == 1
    assert row.fixing_count == 1
    render_calls = remotion.render_batch_calls
    delivered = await runtime.package.run(accepted.production_id)
    assert delivered.state is ProductionState.DELIVERED
    assert remotion.render_batch_calls == render_calls
    again = await runtime.package.run(accepted.production_id)
    assert again.state is ProductionState.DELIVERED
    found = await DeliveryRepository(runtime.ledger).list_for_tenant(
        "tenant-a", accepted.production_id
    )
    assert len(found) == 1
    body = await runtime.deliveries_api.delivery(
        tenant_id="tenant-a", production_id=accepted.production_id
    )
    assert body["checksum"] == found[0].checksum
    assert "generation=1" in body["url"]
    assert "expires=" not in str(body["manifest"])
    with pytest.raises(ComicServiceError):
        await runtime.deliveries_api.delivery(
            tenant_id="tenant-b", production_id=accepted.production_id
        )
    fixing = (await runtime.productions.get_row(accepted.production_id)).stage_facts["FIXING"]
    revision = int(fixing["revision"])
    job = await runtime.deliveries_api.package(
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        revision=revision,
        content_hash=found[0].content_hash,
    )
    replay = await runtime.deliveries_api.package(
        tenant_id="tenant-a",
        production_id=accepted.production_id,
        revision=revision,
        content_hash=found[0].content_hash,
    )
    assert job["created"] is True
    assert replay["created"] is False
    assert job["jobKey"] == replay["jobKey"]


async def test_stale_preview_is_discarded_and_failed_frame_retries_alone() -> None:
    remotion = ScriptedRemotion()
    runtime = _runtime(remotion)
    accepted = await runtime.service.accept("tenant-a", production_request())
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    await runtime.render.run(accepted.production_id)
    row = await runtime.productions.get_row(accepted.production_id)
    assert row.state == ProductionState.PREVIEWING.value

    async def mutate(_frame: int) -> None:
        remotion.on_preview_frame = None
        draft = await runtime.drafts.get(accepted.project_id)
        shot_id = draft.project["shots"][0]["id"]
        await runtime.applier.apply(
            compose_command(
                accepted.project_id,
                "shot/edit",
                {"shotId": shot_id, "durationInFrames": 40},
            )
        )

    remotion.on_preview_frame = mutate
    stayed = await runtime.preview.run(accepted.production_id)
    assert stayed.state is ProductionState.PREVIEWING
    facts = (await runtime.productions.get_row(accepted.production_id)).stage_facts
    assert "PREVIEWING" not in facts

    moved = await runtime.preview.run(accepted.production_id)
    assert moved.state is not ProductionState.PREVIEWING
    fact = (await runtime.productions.get_row(accepted.production_id)).stage_facts["PREVIEWING"]
    current = await runtime.drafts.get(accepted.project_id)
    assert fact["contentHash"] == current.content_hash

    remotion_frames = ScriptedRemotion()
    framed = _runtime(remotion_frames)
    started = await framed.service.accept("tenant-a", production_request(request_id="frames"))
    await framed.analyze.run(started.production_id)
    await framed.voice.run(started.production_id)
    await framed.render.run(started.production_id)
    draft = await framed.drafts.get(started.project_id)
    shot_id = draft.project["shots"][0]["id"]
    shot = draft.project["shots"][0]
    frame = int(shot["from"]) + (int(shot["durationInFrames"]) - 1) // 2
    remotion_frames.fail_once.add((shot_id, frame))
    failed = await framed.preview.run(started.production_id)
    assert failed.state is ProductionState.PREVIEWING
    calls_after_failure = remotion_frames.preview_frame_calls
    retried = await framed.preview.run(started.production_id)
    assert retried.state is not ProductionState.PREVIEWING
    assert remotion_frames.preview_frame_calls == calls_after_failure + 1


async def test_package_failure_retries_packaging_without_another_render() -> None:
    remotion = ScriptedRemotion()
    runtime = _runtime(remotion)
    accepted = await runtime.service.accept("tenant-a", production_request())
    row = await _drive(runtime, accepted.production_id, stop_at=ProductionState.PACKAGING)
    assert row.state == ProductionState.PACKAGING.value
    renders = remotion.render_batch_calls

    class Interrupt:
        def __init__(self) -> None:
            self.inner = PackageBuilder()
            self.calls = 0

        def build(self, entries: list[tuple[str, bytes]]) -> bytes:
            self.calls += 1
            if self.calls == 1:
                raise ComicServiceError("COMPOSE_FAILED", "zip build interrupted", retryable=True)
            return self.inner.build(entries)

    builder = Interrupt()
    runtime.package._builder = builder
    interrupted = await runtime.package.run(accepted.production_id)
    assert interrupted.state is ProductionState.PACKAGING
    assert remotion.render_batch_calls == renders
    done = await runtime.package.run(accepted.production_id)
    assert done.state is ProductionState.DELIVERED
    assert builder.calls == 2
    assert remotion.render_batch_calls == renders


async def test_upload_timeout_reconciles_the_promoted_zip() -> None:
    class TimeoutStore(MemoryObjectStore):
        def __init__(self) -> None:
            super().__init__()
            self.package_puts = 0

        async def put_verified(
            self,
            key: str,
            body: bytes,
            *,
            content_type: str = "application/octet-stream",
        ) -> str:
            digest = await super().put_verified(key, body, content_type=content_type)
            if "/delivery/package-" in key:
                self.package_puts += 1
                if self.package_puts == 1:
                    raise TimeoutError("local timeout")
            return digest

    store = TimeoutStore()
    runtime = _runtime(objects=store)
    accepted = await runtime.service.accept("tenant-a", production_request())
    await _drive(runtime, accepted.production_id, stop_at=ProductionState.PACKAGING)
    delivered = await runtime.package.run(accepted.production_id)
    assert delivered.state is ProductionState.DELIVERED
    assert store.package_puts == 1


async def test_disabled_auto_fix_keeps_the_playable_draft() -> None:
    remotion = ScriptedRemotion()
    directory = TenantDirectory(
        known_tenants=frozenset({"tenant-a"}),
        features=frozenset({"preview", "review", "package", "delivery"}),
    )
    runtime = _runtime(remotion, provider=DurationFindings(), directory=directory)
    accepted = await runtime.service.accept("tenant-a", production_request())
    row = await _drive(runtime, accepted.production_id, stop_at=ProductionState.PACKAGING)
    assert row.fixing_count == 0
    assert "shot/edit" not in remotion.apply_calls
    assert row.state == ProductionState.PACKAGING.value

