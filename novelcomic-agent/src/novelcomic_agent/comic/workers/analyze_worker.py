"""Ingest source pages, analyze panels, and hand off to voice synthesis."""

from __future__ import annotations

import hashlib
from typing import Any

from ..analyzer.image_fetcher import ImageFetcher
from ..analyzer.image_size import ImageDimensionError
from ..analyzer.panel_analyzer import (
    AnalysisPage,
    CropPublisher,
    PanelAnalyzer,
    analysis_input_hash,
)
from ..contracts.errors import ComicServiceError
from ..contracts.ids import page_id_from_bytes
from ..contracts.panel_spec import PanelSpec
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.production_repository import ProductionRepository, load_request
from ..storage.key_layout import artifact_object_key, source_object_key
from ..storage.object_store import ObjectStore
from ..url_policy import require_allowed_https
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import TERMINAL_STATES, ProductionState
from .stage_commit import commit_stage


class AnalyzeWorker:
    """Own INGESTING and ANALYZING. It does not call TTS or Compose."""

    def __init__(
        self,
        *,
        productions: ProductionRepository,
        artifacts: ArtifactRepository,
        objects: ObjectStore,
        analyzer: PanelAnalyzer,
        fetcher: ImageFetcher,
        allowed_hosts: frozenset[str],
    ) -> None:
        self._productions = productions
        self._artifacts = artifacts
        self._objects = objects
        self._analyzer = analyzer
        self._fetcher = fetcher
        self._allowed_hosts = allowed_hosts

    async def run(self, production_id: str) -> ProductionSnapshot:
        for _ in range(8):
            row = await self._productions.get_row(production_id)
            state = ProductionState(row.state)
            if state in TERMINAL_STATES or state not in {
                ProductionState.CREATED,
                ProductionState.INGESTING,
                ProductionState.ANALYZING,
            }:
                return await self._productions.get(production_id)
            try:
                if state is ProductionState.CREATED:
                    await commit_stage(
                        self._productions,
                        production_id,
                        ProductionState.CREATED,
                        {"accepted": True},
                        can_produce_playable=False,
                    )
                elif state is ProductionState.INGESTING:
                    fact = await self._ingest(row)
                    await commit_stage(
                        self._productions,
                        production_id,
                        ProductionState.INGESTING,
                        fact,
                        can_produce_playable=False,
                        degraded=bool(fact["duplicates"]),
                    )
                else:
                    fact = await self._analyze(row)
                    await commit_stage(
                        self._productions,
                        production_id,
                        ProductionState.ANALYZING,
                        fact,
                        can_produce_playable=True,
                        degraded=bool(fact["degraded"]),
                    )
                    return await self._productions.get(production_id)
            except ComicServiceError as exc:
                await self._productions.record_error(
                    production_id,
                    code=exc.code,
                    message=exc.body.message,
                )
                if exc.code == "JOB_LEASE_CONFLICT":
                    continue
                return await self._productions.get(production_id)
        return await self._productions.get(production_id)

    async def _ingest(self, row: Any) -> dict[str, Any]:
        request = load_request(row)
        pages: list[dict[str, Any]] = []
        seen: dict[str, int] = {}
        duplicates: list[int] = []
        for source in sorted(request.source_pages, key=lambda page: page.page_number):
            url = require_allowed_https(str(source.image_url), self._allowed_hosts)
            image = await self._fetcher.fetch(url)
            page_id = page_id_from_bytes(image)
            if page_id in seen:
                duplicates.append(source.page_number)
                pages.append(
                    {
                        "pageNumber": source.page_number,
                        "pageId": page_id,
                        "duplicateOf": seen[page_id],
                    }
                )
                continue
            seen[page_id] = source.page_number
            checksum = hashlib.sha256(image).hexdigest()
            key = source_object_key(
                tenant_id=row.tenant_id,
                production_id=row.production_id,
                page_id=page_id,
                checksum=checksum,
            )
            stored = await self._objects.put_verified(key, image, content_type="image/png")
            if stored != checksum:
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "source checksum mismatch",
                    retryable=True,
                )
            claim = await self._artifacts.claim(
                tenant_id=row.tenant_id,
                project_id=row.project_id,
                stage="ingest",
                input_hash=page_id,
                artifact_id=f"ingest:{row.production_id}:{page_id[:16]}",
                provider="source",
            )
            if claim.artifact.status != "completed":
                await self._artifacts.complete(
                    claim.artifact.artifact_id,
                    urls=[self._objects.stable_url(key)],
                    checksums=[checksum],
                    diagnostics={
                        "objectKey": key,
                        "sourceUrl": url,
                        "pageNumber": source.page_number,
                    },
                    cost_fen=0,
                )
            pages.append(
                {
                    "pageNumber": source.page_number,
                    "pageId": page_id,
                    "sourceUrl": url,
                    "objectKey": key,
                    "checksum": checksum,
                }
            )
        return {"pages": pages, "duplicates": duplicates}

    async def _analyze(self, row: Any) -> dict[str, Any]:
        ingest = row.stage_facts["INGESTING"]["pages"]
        publisher = _CropPublisher(self._objects, row.tenant_id, row.production_id)
        panels: list[dict[str, Any]] = []
        degraded = bool(row.stage_facts["INGESTING"].get("duplicates"))
        page_width = 0
        page_height = 0
        canvas_width = 1080
        canvas_height = 1920
        for page in ingest:
            if page.get("duplicateOf"):
                continue
            image = await self._objects.get(page["objectKey"])
            try:
                analysis = await self._analyze_cached(row, page, image, publisher)
            except ImageDimensionError as exc:
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    str(exc),
                    retryable=False,
                ) from exc
            if page_width == 0 and analysis.page_width > 0:
                page_width = analysis.page_width
                page_height = analysis.page_height
                canvas_width = analysis.canvas_width
                canvas_height = analysis.canvas_height
            if not analysis.gate.accepted:
                degraded = True
            panels.extend(panel.model_dump(mode="json") for panel in analysis.panels)
        if not panels:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "analysis produced no playable panel",
                retryable=True,
            )
        return {
            "panels": panels,
            "degraded": degraded,
            "pageWidth": page_width,
            "pageHeight": page_height,
            "canvasWidth": canvas_width,
            "canvasHeight": canvas_height,
        }

    async def _analyze_cached(
        self,
        row: Any,
        page: dict[str, Any],
        image: bytes,
        publisher: CropPublisher,
    ) -> AnalysisPage:
        request = load_request(row)
        input_hash = analysis_input_hash(
            page["pageId"],
            request.reading_direction,
            self._analyzer.provider_config_version,
        )
        claim = await self._artifacts.claim(
            tenant_id=row.tenant_id,
            project_id=row.project_id,
            stage="analyze",
            input_hash=input_hash,
            artifact_id=f"analyze:{row.production_id}:{page['pageId'][:16]}",
            provider=self._analyzer.provider_config_version,
        )
        if claim.artifact.status == "completed":
            return _analysis_from_artifact(page["pageId"], input_hash, claim.artifact.diagnostics)
        analysis = await self._analyzer.analyze_page(
            image=image,
            source_url=page["sourceUrl"],
            reading_direction=request.reading_direction,
            publisher=publisher,
        )
        await self._artifacts.complete(
            claim.artifact.artifact_id,
            urls=[str(panel.panel_url) for panel in analysis.panels],
            checksums=[
                _panel_checksum(str(panel.panel_url), page["checksum"])
                for panel in analysis.panels
            ],
            diagnostics={
                "panels": [panel.model_dump(mode="json") for panel in analysis.panels],
                "accepted": analysis.gate.accepted,
                "fallbackReason": analysis.gate.fallback_reason,
                "warnings": list(analysis.gate.warnings),
                "requiresManualReview": analysis.gate.requires_manual_review,
                "raw": analysis.raw,
                "pageWidth": analysis.page_width,
                "pageHeight": analysis.page_height,
                "canvasWidth": analysis.canvas_width,
                "canvasHeight": analysis.canvas_height,
            },
            cost_fen=0,
        )
        return analysis


class _CropPublisher:
    def __init__(self, objects: ObjectStore, tenant_id: str, production_id: str) -> None:
        self._objects = objects
        self._tenant_id = tenant_id
        self._production_id = production_id

    async def publish(self, *, page_id: str, panel_index: int, body: bytes) -> str:
        checksum = hashlib.sha256(body).hexdigest()
        key = artifact_object_key(
            tenant_id=self._tenant_id,
            production_id=self._production_id,
            stage="analyze",
            name=f"panel-{page_id[:16]}-{panel_index}",
            checksum=checksum,
        )
        await self._objects.put_verified(key, body, content_type="application/octet-stream")
        return self._objects.stable_url(key)


def _panel_checksum(url: str, page_checksum: str) -> str:
    suffix = url.rsplit("-", 1)[-1]
    if len(suffix) == 64 and all(character in "0123456789abcdef" for character in suffix):
        return suffix
    return page_checksum


def _analysis_from_artifact(
    page_id: str,
    input_hash: str,
    diagnostics: dict[str, Any],
) -> AnalysisPage:
    from ..analyzer.panel_quality_gate import PanelGateResult

    panels = tuple(PanelSpec.model_validate(item) for item in diagnostics["panels"])
    gate = PanelGateResult(
        accepted=bool(diagnostics.get("accepted")),
        warnings=tuple(diagnostics.get("warnings") or []),
        fallback_reason=diagnostics.get("fallbackReason"),
        requires_manual_review=bool(diagnostics.get("requiresManualReview")),
        panels=(),
    )
    return AnalysisPage(
        page_id=page_id,
        input_hash=input_hash,
        panels=panels,
        gate=gate,
        raw=diagnostics.get("raw") or {},
        page_width=int(diagnostics.get("pageWidth") or 0),
        page_height=int(diagnostics.get("pageHeight") or 0),
        canvas_width=int(diagnostics.get("canvasWidth") or 1080),
        canvas_height=int(diagnostics.get("canvasHeight") or 1920),
    )
