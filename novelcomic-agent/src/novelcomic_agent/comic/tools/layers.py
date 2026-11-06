"""Controlled L1 prepare and import. Import goes through the Compose CAS ledger."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from ..assets.l0_panel import shot_plates
from ..assets.l1_layer_service import L1LayerService, LayerProvider
from ..assets.layer_quality_gate import LayerGateThresholds
from ..contracts.errors import ComicServiceError
from ..contracts.layer_package import (
    LayerPackage,
    layers_import_payload,
    package_input_hash,
)
from ..drafts.apply_compose_command import ComposeCommandApplier
from ..rendering.commands import compose_command
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import (
    ProductionNotFoundError,
    ProductionRepository,
    load_request,
)
from ..storage.object_store import ObjectStore
from ..url_policy import require_allowed_https


class LayerTools:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        drafts: LedgerDraftRepository,
        applier: ComposeCommandApplier,
        provider: LayerProvider,
        allowed_hosts: frozenset[str],
        provider_name: str,
        model_version: str,
        parameter_version: str,
        worst_case_fen: int,
        thresholds: LayerGateThresholds | None = None,
    ) -> None:
        self._productions = productions
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._drafts = drafts
        self._applier = applier
        self._provider = provider
        self._allowed_hosts = allowed_hosts
        self._provider_name = provider_name
        self._model_version = model_version
        self._parameter_version = parameter_version
        self._worst_case_fen = worst_case_fen
        self._thresholds = thresholds or LayerGateThresholds()

    async def prepare(self, tenant_id: str, production_id: str, shot_id: str) -> dict[str, Any]:
        """Generate or validate one package. This does not import or advance state."""

        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        if row.cancel_requested_at is not None:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "production is cancelled",
                retryable=False,
            )
        request = load_request(row)
        plate = next(
            (item for item in shot_plates(row.stage_facts) if item.shot.shot_id == shot_id),
            None,
        )
        if plate is None:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "shot was not found on the production",
                retryable=False,
                details={"shotId": shot_id},
            )
        service = self._service(row.tenant_id, row.production_id, row.project_id)
        attempt = await service.prepare_shot(
            shot_id=shot_id,
            source_url=str(plate.shot.panel_url),
            source_checksum=plate.source_checksum,
            canvas_width=request.output.width,
            canvas_height=request.output.height,
        )
        package = None if attempt.package is None else attempt.package.wire()
        return {
            "shotId": shot_id,
            "effectiveLevel": attempt.effective_level,
            "fallbackReason": attempt.downgrade_reason,
            "inputHash": None if attempt.package is None else package_input_hash(attempt.package),
            "artifactInputHash": attempt.input_hash,
            "package": package,
            "warnings": list(attempt.warnings),
            "pending": attempt.pending,
        }

    async def import_package(
        self,
        tenant_id: str,
        production_id: str,
        *,
        shot_id: str,
        expected_revision: int,
        input_hash: str,
        package: LayerPackage | dict[str, Any],
    ) -> dict[str, Any]:
        row = await self._productions.get_for_tenant(tenant_id, production_id)
        if row is None:
            raise ProductionNotFoundError(production_id)
        if row.cancel_requested_at is not None:
            raise ComicServiceError(
                "PRODUCTION_CANCELLED",
                "production is cancelled",
                retryable=False,
            )
        try:
            parsed = package
            if not isinstance(parsed, LayerPackage):
                parsed = LayerPackage.model_validate(package)
        except ValidationError as exc:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "layer package is invalid",
                retryable=False,
                details={"errorCount": exc.error_count()},
            ) from exc
        if parsed.shot_id != shot_id or parsed.project_id != row.project_id:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "layer package is not bound to this shot",
                retryable=False,
                details={"shotId": shot_id},
            )
        if package_input_hash(parsed) != input_hash:
            raise ComicServiceError(
                "INVALID_REQUEST",
                "layer package input hash does not match",
                retryable=False,
            )
        require_allowed_https(str(parsed.source_url), self._allowed_hosts)
        for layer in parsed.layers:
            require_allowed_https(str(layer.image_url), self._allowed_hosts)
        draft = await self._drafts.get(row.project_id)
        if draft.revision != expected_revision:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "import is not bound to the committed revision",
                retryable=True,
                details={"revision": draft.revision},
            )
        if parsed.diagnostics.requires_fallback:
            return {
                "commandId": None,
                "revision": draft.revision,
                "effectiveLevel": "L0",
                "fallbackReason": "provider-requires-fallback",
            }
        command = compose_command(row.project_id, "layers/import", layers_import_payload(parsed))
        try:
            applied = await self._applier.apply(command)
        except ComicServiceError as exc:
            if exc.code == "DRAFT_REVISION_CONFLICT":
                applied = await self._applier.apply(command)
            elif exc.body.retryable:
                raise
            else:
                return {
                    "commandId": command.command_id,
                    "revision": draft.revision,
                    "effectiveLevel": "L0",
                    "fallbackReason": "compose-failed",
                }
        return {
            "commandId": applied.command_id,
            "revision": applied.resulting_revision,
            "effectiveLevel": "L1",
            "fallbackReason": None,
        }

    def _service(self, tenant_id: str, production_id: str, project_id: str) -> L1LayerService:
        return L1LayerService(
            artifacts=self._artifacts,
            costs=self._costs,
            objects=self._objects,
            provider=self._provider,
            tenant_id=tenant_id,
            production_id=production_id,
            project_id=project_id,
            provider_name=self._provider_name,
            model_version=self._model_version,
            parameter_version=self._parameter_version,
            allowed_hosts=self._allowed_hosts,
            worst_case_fen=self._worst_case_fen,
            thresholds=self._thresholds,
        )
