"""Paid L1 separation with artifact reuse, checksums, and structured fallback."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal, Protocol

from ..canonical import hash_content, stable_stringify
from ..contracts.errors import ComicServiceError
from ..contracts.layer_package import (
    L1_SEMANTICS,
    SEMANTIC_CATALOG_VERSION,
    Layer,
    LayerAnchor,
    LayerBounds,
    LayerCanvas,
    LayerDiagnostics,
    LayerPackage,
)
from ..persistence.rows import ArtifactRow
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..storage.key_layout import artifact_object_key
from ..storage.object_store import ObjectStore
from ..url_policy import require_allowed_https
from ..workflow.cost_budget import CostReservation, enhancement_allowed
from ..workflow.retry_policy import RetryContext, decide_retry
from .layer_quality_gate import LayerGateResult, LayerGateThresholds, evaluate_layers

_PNG = b"\x89PNG\r\n\x1a\n"
_DEFAULT_Z = {
    "background": 0,
    "body": 10,
    "arm-left": 15,
    "arm-right": 16,
    "head": 20,
    "hair": 22,
    "other": 30,
    "foreground": 40,
    "effect": 50,
}
_MOTIONS = {"static", "camera-only", "subtle", "free"}


class ProviderTimeout(Exception):
    """The provider may already have accepted this request id."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.request_id = request_id


class LayerProviderError(Exception):
    def __init__(self, code: str, *, permanent: bool) -> None:
        super().__init__(code)
        self.code = code
        self.permanent = permanent


@dataclass(frozen=True, slots=True)
class ProviderLayer:
    semantic: str
    image: bytes
    z_index: int | None = None
    visible: bool = True
    bounds: tuple[float, float, float, float] | None = None
    anchor: tuple[float, float] | None = None
    confidence: float = 1.0
    motion_policy: str | None = None
    name: str | None = None


@dataclass(frozen=True, slots=True)
class LayerSeparation:
    provider_request_id: str
    cost_fen: int
    layers: tuple[ProviderLayer, ...]
    recomposition_score: float
    alpha_hole_ratio: float
    edge_artifact_score: float
    warnings: tuple[str, ...] = ()
    requires_fallback: bool = False


class LayerProvider(Protocol):
    async def separate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
    ) -> LayerSeparation:
        """Separate one plate. The request id is the provider idempotency key."""

    async def reconcile(self, request_id: str) -> LayerSeparation | None:
        """Return an accepted separation, or None while it is still open."""


@dataclass(frozen=True, slots=True)
class LayerAttempt:
    shot_id: str
    effective_level: Literal["L0", "L1"]
    downgrade_reason: str | None
    package: LayerPackage | None
    artifact_id: str | None
    input_hash: str
    pending: bool = False
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class _NormalizedLayer:
    layer_id: str
    name: str
    semantic: str
    image: bytes
    z_index: int
    visible: bool
    x: float
    y: float
    width: float
    height: float
    anchor_x: float
    anchor_y: float
    confidence: float
    motion_policy: str


class L1LayerService:
    def __init__(
        self,
        *,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        provider: LayerProvider,
        tenant_id: str,
        production_id: str,
        project_id: str,
        provider_name: str,
        model_version: str,
        parameter_version: str,
        allowed_hosts: frozenset[str],
        worst_case_fen: int,
        thresholds: LayerGateThresholds | None = None,
    ) -> None:
        self._artifacts = artifacts
        self._costs = costs
        self._objects = objects
        self._provider = provider
        self._tenant_id = tenant_id
        self._production_id = production_id
        self._project_id = project_id
        self._provider_name = provider_name
        self._model_version = model_version
        self._parameter_version = parameter_version
        self._allowed_hosts = allowed_hosts
        self._worst_case_fen = worst_case_fen
        self._thresholds = thresholds or LayerGateThresholds()

    async def prepare_shot(
        self,
        *,
        shot_id: str,
        source_url: str,
        source_checksum: str,
        canvas_width: int,
        canvas_height: int,
        cancelled: bool = False,
    ) -> LayerAttempt:
        if cancelled:
            return _fallback(shot_id, "production-cancelled", input_hash="")
        try:
            require_allowed_https(source_url, self._allowed_hosts)
        except ComicServiceError:
            return _fallback(shot_id, "url-not-allowlisted", input_hash="")
        input_hash = layer_input_hash(
            project_id=self._project_id,
            shot_id=shot_id,
            source_checksum=source_checksum,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            model_version=self._model_version,
            parameter_version=self._parameter_version,
            threshold_version=self._thresholds.version,
        )
        artifact_id = f"l1:{self._production_id}:{input_hash[:32]}"
        claim = await self._artifacts.claim(
            tenant_id=self._tenant_id,
            project_id=self._project_id,
            stage="layer-l1",
            input_hash=input_hash,
            artifact_id=artifact_id,
            provider=self._provider_name,
            shot_id=shot_id,
        )
        artifact = claim.artifact
        if artifact.status == "completed":
            return _from_completed(artifact)
        if claim.exhausted:
            return _fallback(
                shot_id,
                "quality-failed-twice",
                input_hash=input_hash,
                artifact_id=artifact.artifact_id,
            )
        if artifact.provider_request_id:
            reconciled = await self._provider.reconcile(artifact.provider_request_id)
            if reconciled is not None:
                return await self._accept(
                    artifact,
                    reconciled,
                    source_url=source_url,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                )
            if not claim.start_work or artifact.diagnostics.get("reconciliationRequired"):
                return _pending(shot_id, input_hash, artifact.artifact_id)
        if not claim.start_work:
            return _pending(shot_id, input_hash, artifact.artifact_id)

        snapshot = await self._costs.snapshot(self._production_id, shot_id)
        if not enhancement_allowed(snapshot):
            await self._artifacts.fail(
                artifact.artifact_id,
                diagnostics={"reason": "enhancement-budget-stopped", "shotId": shot_id},
            )
            return _fallback(
                shot_id,
                "enhancement-budget-stopped",
                input_hash=input_hash,
                artifact_id=artifact.artifact_id,
            )
        reserved = await self._costs.reserve_operation(
            CostReservation(
                reservation_id=artifact.artifact_id,
                production_id=self._production_id,
                worst_case_fen=self._worst_case_fen,
                shot_id=shot_id,
                provider_request_id=artifact.artifact_id,
            ),
            provider=self._provider_name,
        )
        if not reserved:
            await self._artifacts.fail(
                artifact.artifact_id,
                diagnostics={"reason": "budget-exceeded", "shotId": shot_id},
            )
            return _fallback(
                shot_id,
                "budget-exceeded",
                input_hash=input_hash,
                artifact_id=artifact.artifact_id,
            )
        artifact = await self._artifacts.attach_provider_request(
            artifact.artifact_id,
            artifact.artifact_id,
        )
        try:
            separation = await self._separate(
                artifact.artifact_id,
                shot_id=shot_id,
                source_url=source_url,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                cancelled=cancelled,
            )
        except ProviderTimeout:
            await self._artifacts.update_diagnostics(
                artifact.artifact_id,
                {"reconciliationRequired": True, "shotId": shot_id},
            )
            await self._costs.mark_reconciliation(artifact.artifact_id, artifact.artifact_id)
            reconciled = await self._provider.reconcile(artifact.artifact_id)
            if reconciled is None:
                return _pending(shot_id, input_hash, artifact.artifact_id)
            separation = reconciled
        except LayerProviderError as exc:
            await self._costs.release(artifact.artifact_id)
            reason = exc.code if exc.permanent else "provider-temporary"
            return await self._finish(
                artifact,
                outcome="fallback",
                reason=reason,
                package=None,
                warnings=(),
                cost_fen=0,
                settle=False,
                source_url=source_url,
                checksums=[],
            )
        return await self._accept(
            artifact,
            separation,
            source_url=source_url,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
        )

    async def _separate(
        self,
        request_id: str,
        *,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        cancelled: bool,
    ) -> LayerSeparation:
        attempt = 0
        while True:
            try:
                return await self._provider.separate(
                    request_id=request_id,
                    shot_id=shot_id,
                    source_url=source_url,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                    model_version=self._model_version,
                    parameter_version=self._parameter_version,
                )
            except ProviderTimeout:
                raise
            except LayerProviderError as exc:
                if exc.permanent:
                    raise
                decision = decide_retry(
                    RetryContext(
                        category="image-quality",
                        attempt=attempt,
                        retryable=True,
                        cancelled=cancelled,
                        budget_available=True,
                    )
                )
                attempt += 1
                if decision.action != "retry":
                    raise LayerProviderError(exc.code, permanent=True) from exc

    async def _accept(
        self,
        artifact: ArtifactRow,
        separation: LayerSeparation,
        *,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
    ) -> LayerAttempt:
        if separation.cost_fen > self._worst_case_fen:
            await self._costs.mark_reconciliation(
                artifact.artifact_id,
                separation.provider_request_id,
            )
            await self._artifacts.fail(
                artifact.artifact_id,
                diagnostics={"reason": "budget-exceeded", "shotId": artifact.shot_id},
            )
            return _fallback(
                str(artifact.shot_id),
                "budget-exceeded",
                input_hash=artifact.input_hash,
                artifact_id=artifact.artifact_id,
            )
        normalized, reason = _normalize(
            separation.layers,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
        )
        if reason is not None or normalized is None:
            return await self._finish(
                artifact,
                outcome="fallback",
                reason=reason or "partial-response",
                package=None,
                warnings=separation.warnings,
                cost_fen=separation.cost_fen,
                settle=True,
                source_url=source_url,
                checksums=[],
            )
        uploaded, checksums, upload_reason = await self._upload(artifact, normalized)
        if upload_reason is not None or uploaded is None:
            return await self._finish(
                artifact,
                outcome="fallback",
                reason=upload_reason or "checksum-mismatch",
                package=None,
                warnings=separation.warnings,
                cost_fen=separation.cost_fen,
                settle=True,
                source_url=source_url,
                checksums=[],
            )
        package = _package(
            project_id=self._project_id,
            shot_id=str(artifact.shot_id),
            source_url=source_url,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            layers=uploaded,
            separation=separation,
        )
        gate = evaluate_layers(
            package,
            expected_canvas=(canvas_width, canvas_height),
            checksums=checksums,
            expected_checksums=checksums,
            thresholds=self._thresholds,
        )
        if not gate.accepted:
            package = _stamp_fallback(package, gate)
        return await self._finish(
            artifact,
            outcome="accepted" if gate.accepted else "fallback",
            reason=gate.reason_code,
            package=package,
            warnings=gate.warnings,
            cost_fen=separation.cost_fen,
            settle=True,
            source_url=source_url,
            checksums=[checksums[str(layer.image_url)] for layer in package.layers],
        )

    async def _upload(
        self,
        artifact: ArtifactRow,
        layers: list[_NormalizedLayer],
    ) -> tuple[list[tuple[_NormalizedLayer, str]] | None, dict[str, str], str | None]:
        stored: list[tuple[_NormalizedLayer, str]] = []
        checksums: dict[str, str] = {}
        for layer in layers:
            digest = hashlib.sha256(layer.image).hexdigest()
            key = artifact_object_key(
                tenant_id=self._tenant_id,
                production_id=self._production_id,
                stage="layer-l1",
                name=f"{artifact.shot_id}-{layer.layer_id}",
                checksum=digest,
            )
            try:
                written = await self._objects.put_verified(
                    key,
                    layer.image,
                    content_type="image/png",
                )
                confirmed = await self._objects.checksum(key)
            except ValueError:
                return None, {}, "checksum-mismatch"
            if written != digest or confirmed != digest:
                return None, {}, "checksum-mismatch"
            url = self._objects.stable_url(key)
            try:
                require_allowed_https(url, self._allowed_hosts)
            except ComicServiceError:
                return None, {}, "url-not-allowlisted"
            stored.append((layer, url))
            checksums[url] = digest
        return stored, checksums, None

    async def _finish(
        self,
        artifact: ArtifactRow,
        *,
        outcome: str,
        reason: str | None,
        package: LayerPackage | None,
        warnings: tuple[str, ...],
        cost_fen: int,
        settle: bool,
        source_url: str,
        checksums: list[str],
    ) -> LayerAttempt:
        del source_url
        diagnostics: dict[str, object] = {
            "outcome": outcome,
            "reason": reason,
            "warnings": list(warnings),
            "thresholdVersion": self._thresholds.version,
            "modelVersion": self._model_version,
            "parameterVersion": self._parameter_version,
            "shotId": artifact.shot_id,
        }
        if package is not None:
            diagnostics["package"] = package.wire()
            urls = [str(layer.image_url) for layer in package.layers]
            if len(checksums) != len(urls):
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "layer checksum count does not match the package",
                    retryable=True,
                )
        else:
            body = stable_stringify(diagnostics).encode()
            digest = hashlib.sha256(body).hexdigest()
            key = artifact_object_key(
                tenant_id=self._tenant_id,
                production_id=self._production_id,
                stage="layer-l1",
                name=f"{artifact.shot_id}-fallback",
                checksum=digest,
            )
            written = await self._objects.put_verified(
                key,
                body,
                content_type="application/json",
            )
            if written != digest or await self._objects.checksum(key) != digest:
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "layer diagnostic checksum mismatch",
                    retryable=True,
                )
            urls = [self._objects.stable_url(key)]
            checksums = [digest]
            diagnostics["objectKey"] = key
        if settle:
            await self._costs.settle(artifact.artifact_id, cost_fen)
        else:
            await self._costs.release(artifact.artifact_id)
        await self._artifacts.complete(
            artifact.artifact_id,
            urls=urls,
            checksums=checksums,
            diagnostics=diagnostics,
            cost_fen=cost_fen if settle else 0,
            provider_request_id=artifact.provider_request_id,
        )
        return LayerAttempt(
            shot_id=str(artifact.shot_id),
            effective_level="L1" if outcome == "accepted" else "L0",
            downgrade_reason=None if outcome == "accepted" else reason,
            package=package,
            artifact_id=artifact.artifact_id,
            input_hash=artifact.input_hash,
            warnings=warnings,
        )


def layer_input_hash(
    *,
    project_id: str,
    shot_id: str,
    source_checksum: str,
    canvas_width: int,
    canvas_height: int,
    model_version: str,
    parameter_version: str,
    threshold_version: str,
) -> str:
    return hash_content(
        {
            "canvas": {"height": canvas_height, "width": canvas_width},
            "modelVersion": model_version,
            "parameterVersion": parameter_version,
            "projectId": project_id,
            "schemaVersion": 1,
            "semanticCatalogVersion": SEMANTIC_CATALOG_VERSION,
            "shotId": shot_id,
            "sourceChecksum": source_checksum,
            "thresholdVersion": threshold_version,
        }
    )


def png_color_type(image: bytes) -> int | None:
    """Return the IHDR color type, or None when the header is not a PNG."""

    if len(image) < 26 or not image.startswith(_PNG) or image[12:16] != b"IHDR":
        return None
    return image[25]


def _normalize(
    layers: tuple[ProviderLayer, ...],
    *,
    canvas_width: int,
    canvas_height: int,
) -> tuple[list[_NormalizedLayer] | None, str | None]:
    if not layers:
        return None, "partial-response"
    normalized: list[_NormalizedLayer] = []
    seen: set[str] = set()
    for layer in layers:
        if layer.semantic not in L1_SEMANTICS:
            return None, "unknown-semantic"
        if layer.semantic in seen:
            return None, "duplicate-layer-id"
        seen.add(layer.semantic)
        color_type = png_color_type(layer.image)
        if color_type is None:
            return None, "corrupt-alpha"
        if layer.semantic != "background" and color_type not in {4, 6}:
            return None, "corrupt-alpha"
        if not 0 <= layer.confidence <= 1:
            return None, "partial-response"
        bounds = layer.bounds
        if bounds is None:
            if layer.semantic != "background":
                return None, "partial-response"
            bounds = (0.0, 0.0, float(canvas_width), float(canvas_height))
        x, y, width, height = bounds
        if width <= 0 or height <= 0:
            return None, "partial-response"
        anchor = layer.anchor or (0.5, 0.5)
        if anchor[0] < 0 or anchor[0] > 1 or anchor[1] < 0 or anchor[1] > 1:
            return None, "anchor-out-of-range"
        motion = layer.motion_policy or ("static" if layer.semantic == "background" else "subtle")
        if motion not in _MOTIONS:
            return None, "partial-response"
        normalized.append(
            _NormalizedLayer(
                layer_id=layer.semantic,
                name=layer.name or layer.semantic,
                semantic=layer.semantic,
                image=layer.image,
                z_index=layer.z_index if layer.z_index is not None else _DEFAULT_Z[layer.semantic],
                visible=layer.visible,
                x=x,
                y=y,
                width=width,
                height=height,
                anchor_x=anchor[0],
                anchor_y=anchor[1],
                confidence=layer.confidence,
                motion_policy=motion,
            )
        )
    if "background" not in seen or not seen.intersection(
        {"foreground", "body", "head", "arm-left", "arm-right", "hair"}
    ):
        return None, "partial-response"
    return normalized, None


def _package(
    *,
    project_id: str,
    shot_id: str,
    source_url: str,
    canvas_width: int,
    canvas_height: int,
    layers: list[tuple[_NormalizedLayer, str]],
    separation: LayerSeparation,
) -> LayerPackage:
    return LayerPackage(
        project_id=project_id,
        shot_id=shot_id,  # type: ignore[arg-type]
        source_url=source_url,  # type: ignore[arg-type]
        canvas=LayerCanvas(width=canvas_width, height=canvas_height),
        layers=[
            Layer(
                layer_id=layer.layer_id,
                name=layer.name,
                semantic=layer.semantic,  # type: ignore[arg-type]
                image_url=url,  # type: ignore[arg-type]
                z_index=layer.z_index,
                visible=layer.visible,
                bounds=LayerBounds(x=layer.x, y=layer.y, width=layer.width, height=layer.height),
                anchor=LayerAnchor(x=layer.anchor_x, y=layer.anchor_y),
                confidence=layer.confidence,
                motion_policy=layer.motion_policy,  # type: ignore[arg-type]
            )
            for layer, url in layers
        ],
        diagnostics=LayerDiagnostics(
            recomposition_score=separation.recomposition_score,
            alpha_hole_ratio=separation.alpha_hole_ratio,
            edge_artifact_score=separation.edge_artifact_score,
            requires_fallback=separation.requires_fallback,
            warnings=list(separation.warnings),
        ),
    )


def _stamp_fallback(package: LayerPackage, gate: LayerGateResult) -> LayerPackage:
    warnings = list(
        dict.fromkeys([*package.diagnostics.warnings, *gate.warnings, gate.reason_code or ""])
    )
    warnings = [warning for warning in warnings if warning]
    return package.model_copy(
        update={
            "diagnostics": package.diagnostics.model_copy(
                update={"requires_fallback": True, "warnings": warnings}
            )
        }
    )


def _fallback(
    shot_id: str,
    reason: str,
    *,
    input_hash: str,
    artifact_id: str | None = None,
) -> LayerAttempt:
    return LayerAttempt(
        shot_id=shot_id,
        effective_level="L0",
        downgrade_reason=reason,
        package=None,
        artifact_id=artifact_id,
        input_hash=input_hash,
    )


def _pending(shot_id: str, input_hash: str, artifact_id: str) -> LayerAttempt:
    return LayerAttempt(
        shot_id=shot_id,
        effective_level="L0",
        downgrade_reason="provider-reconciliation-pending",
        package=None,
        artifact_id=artifact_id,
        input_hash=input_hash,
        pending=True,
    )


def _from_completed(artifact: ArtifactRow) -> LayerAttempt:
    outcome = str(artifact.diagnostics.get("outcome") or "fallback")
    package = None
    payload = artifact.diagnostics.get("package")
    if isinstance(payload, dict):
        package = LayerPackage.model_validate(payload)
    requires_fallback = package is not None and package.diagnostics.requires_fallback
    accepted = outcome == "accepted" and package is not None and not requires_fallback
    reason = artifact.diagnostics.get("reason") or "quality-failed"
    return LayerAttempt(
        shot_id=str(artifact.shot_id),
        effective_level="L1" if accepted else "L0",
        downgrade_reason=None if accepted else str(reason),
        package=package,
        artifact_id=artifact.artifact_id,
        input_hash=artifact.input_hash,
        warnings=tuple(artifact.diagnostics.get("warnings") or []),
    )
