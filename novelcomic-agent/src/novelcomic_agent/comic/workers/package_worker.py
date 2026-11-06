"""Build the delivery ZIP from completed renders. A packaging failure does not render again."""

from __future__ import annotations

import hashlib

from ..canonical import stable_stringify
from ..contracts.errors import ComicServiceError
from ..delivery.manifest_builder import blocking_reason, build_manifest, package_input_hash
from ..delivery.package_builder import PackageBuilder
from ..operations.alerting import AlertFact, AlertService
from ..operations.tenant_policy import TenantDirectory, auth_context, evaluate, quota_facts
from ..persistence.rows import DeliveryRow, ProductionRow, utcnow
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.delivery_repository import DeliveryRepository
from ..repositories.draft_repository import LedgerDraftRepository
from ..repositories.production_repository import ProductionRepository
from ..repositories.render_repository import RenderRepository
from ..storage.key_layout import delivery_object_key
from ..storage.object_store import ObjectStore
from ..workflow.production_state_machine import ProductionSnapshot
from ..workflow.production_states import ProductionState


class PackageWorker:
    def __init__(
        self,
        *,
        productions: ProductionRepository,
        drafts: LedgerDraftRepository,
        artifacts: ArtifactRepository,
        renders: RenderRepository,
        deliveries: DeliveryRepository,
        objects: ObjectStore,
        directory: TenantDirectory,
        alerts: AlertService | None = None,
        builder: PackageBuilder | None = None,
    ) -> None:
        self._productions = productions
        self._drafts = drafts
        self._artifacts = artifacts
        self._renders = renders
        self._deliveries = deliveries
        self._objects = objects
        self._directory = directory
        self._alerts = alerts
        self._builder = builder or PackageBuilder()

    async def run(self, production_id: str) -> ProductionSnapshot:
        row = await self._productions.get_row(production_id)
        if ProductionState(row.state) is not ProductionState.PACKAGING:
            return await self._productions.get(production_id)
        if not self._permitted(row):
            await self._productions.record_error(
                production_id,
                code="STAGE_GUARD_REJECTED",
                message="tenant policy rejected packaging",
            )
            return await self._productions.get(production_id)
        try:
            await self._package(row)
        except ComicServiceError as exc:
            await self._productions.record_error(
                production_id,
                code=exc.code,
                message=exc.body.message,
            )
            await self._notify(row, exc.code)
        except TimeoutError:
            await self._productions.record_error(
                production_id,
                code="COMPOSE_FAILED",
                message="package upload timed out",
            )
            await self._notify(row, "PACKAGE_TIMEOUT")
        return await self._productions.get(production_id)

    async def _package(self, row: ProductionRow) -> None:
        rendered = row.stage_facts.get("RENDERING_BATCHES") or {}
        content_hash = rendered.get("contentHash")
        if not isinstance(content_hash, str):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "packaging has no locked render content hash",
                retryable=False,
            )
        draft = await self._drafts.get(row.project_id)
        if draft.content_hash != content_hash:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                "package input is not bound to the rendered content hash",
                retryable=False,
            )
        artifacts = await self._artifacts.list_project(row.project_id)
        batches = await self._renders.list_for_hash(row.project_id, content_hash)
        manifest = await build_manifest(
            row=row,
            project=draft.project,
            content_hash=content_hash,
            artifacts=artifacts,
            batches=batches,
            objects=self._objects,
            generated_at=utcnow().isoformat(),
        )
        reason = blocking_reason(manifest)
        if reason:
            raise ComicServiceError("STAGE_GUARD_REJECTED", reason, retryable=False)
        input_hash = package_input_hash(manifest)
        existing = await self._deliveries.find(row.production_id, input_hash)
        if existing is not None and await self._readable(existing.object_key, existing.checksum):
            current = await self._productions.get_row(row.production_id)
            await self._productions.complete_packaging(
                production_id=row.production_id,
                expected_version=current.version,
                delivery=existing,
            )
            return
        entries: list[tuple[str, bytes]] = []
        for item in manifest.files:
            if item.missing_reason or not item.object_key or not item.checksum:
                continue
            body = await self._objects.get(item.object_key)
            digest = hashlib.sha256(body).hexdigest()
            if digest != item.checksum:
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "package source checksum mismatch",
                    retryable=True,
                )
            entries.append((item.path, body))
        document = stable_stringify(manifest.model_dump(mode="json", by_alias=True)).encode()
        entries.append(("manifest.json", document))
        blob = self._builder.build(entries)
        digest = hashlib.sha256(blob).hexdigest()
        key = delivery_object_key(
            tenant_id=row.tenant_id,
            production_id=row.production_id,
            name="package",
            checksum=digest,
        )
        stored = await self._put(key, blob, digest)
        size = await self._objects.head(key)
        confirmed = await self._objects.checksum(key)
        if size is None or stored != digest or size != len(blob) or confirmed != digest:
            raise ComicServiceError("COMPOSE_FAILED", "package checksum mismatch", retryable=True)
        current = await self._productions.get_row(row.production_id)
        await self._productions.complete_packaging(
            production_id=row.production_id,
            expected_version=current.version,
            delivery=DeliveryRow(
                delivery_id=f"del:{row.production_id}:{input_hash[:16]}",
                tenant_id=row.tenant_id,
                production_id=row.production_id,
                project_id=row.project_id,
                package_input_hash=input_hash,
                content_hash=content_hash,
                object_key=key,
                checksum=digest,
                size_bytes=size,
                status="active",
                url_generation=1,
                manifest_json=manifest.model_dump(mode="json", by_alias=True),
                play_order=list(manifest.play_order),
                created_at=utcnow(),
                revoked_at=None,
            ),
        )

    async def _put(self, key: str, blob: bytes, digest: str) -> str:
        try:
            return await self._objects.put_verified(key, blob, content_type="application/zip")
        except TimeoutError:
            found = await self._objects.checksum(key)
            if found == digest:
                return found
            raise

    async def _readable(self, key: str, checksum: str) -> bool:
        present = await self._objects.head(key) is not None
        return present and await self._objects.checksum(key) == checksum

    def _permitted(self, row: ProductionRow) -> bool:
        decision = evaluate(
            auth_context(self._directory, row.tenant_id),
            resource_tenant_id=row.tenant_id,
            facts=quota_facts(self._directory),
            feature="package",
        )
        return decision.allowed

    async def _notify(self, row: ProductionRow, code: str) -> None:
        if self._alerts is None:
            return
        try:
            await self._alerts.handle(
                AlertFact(
                    tenant_id=row.tenant_id,
                    production_id=row.production_id,
                    stage="PACKAGING",
                    error_code=code,
                    kind="package-corrupt",
                    observed_at=utcnow(),
                )
            )
        except Exception:
            return
