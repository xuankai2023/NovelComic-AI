"""Paid L2 eye/mouth states. A missing state is recorded and never invented."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from ..canonical import hash_content, stable_stringify
from ..contracts.errors import ComicServiceError
from ..contracts.layer_package import Layer, LayerAnchor, LayerBounds, LayerCanvas, LayerPackage
from ..contracts.sprite_state import (
    SPRITE_CATALOG_VERSION,
    SpriteAssetSet,
    SpriteStateAsset,
    required_state_keys,
    sprite_asset_id,
    state_key,
)
from ..persistence.rows import ArtifactRow
from ..repositories.artifact_repository import ArtifactRepository
from ..repositories.cost_repository import CostRepository
from ..storage.key_layout import artifact_object_key
from ..storage.object_store import ObjectStore
from ..url_policy import require_allowed_https
from ..workflow.cost_budget import CostReservation, enhancement_allowed
from ..workflow.retry_policy import RetryContext, decide_retry
from .sprite_quality_gate import SpriteGateThresholds

_PNG = b"\x89PNG\r\n\x1a\n"
_KNOWN_STATES = frozenset(
    {
        "eye:open",
        "eye:closed",
        "mouth:closed",
        "mouth:open",
        "mouth:half",
    }
)


class ProviderTimeout(Exception):
    """The provider may already have accepted this request id."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.request_id = request_id


class SpriteProviderError(Exception):
    def __init__(self, code: str, *, permanent: bool) -> None:
        super().__init__(code)
        self.code = code
        self.permanent = permanent


@dataclass(frozen=True, slots=True)
class ProviderSpriteState:
    part: str
    semantic: str
    image: bytes
    bounds: tuple[float, float, float, float] | None = None
    anchor: tuple[float, float] | None = None


@dataclass(frozen=True, slots=True)
class SpriteGeneration:
    provider_request_id: str
    cost_fen: int
    states: tuple[ProviderSpriteState, ...]
    missing: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


class SpriteProvider(Protocol):
    async def generate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
        required_states: tuple[str, ...],
    ) -> SpriteGeneration:
        """Build state images. request_id is the provider idempotency key."""

    async def reconcile(self, request_id: str) -> SpriteGeneration | None:
        """Return an accepted generation, or None while it is still open."""


@dataclass(frozen=True, slots=True)
class SpriteAttempt:
    shot_id: str
    asset_set: SpriteAssetSet | None
    artifact_id: str | None
    input_hash: str
    downgrade_reason: str | None
    pending: bool = False
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class _PngHeader:
    width: int
    height: int
    color_type: int


@dataclass(frozen=True, slots=True)
class _NormalizedState:
    part: str
    semantic: str
    image: bytes
    width: int
    height: int
    color_type: int
    x: float
    y: float
    bounds_width: float
    bounds_height: float
    anchor_x: float
    anchor_y: float


class L2SpriteService:
    """Turn one accepted L1 face plate into state images. It does not write motion."""

    def __init__(
        self,
        *,
        artifacts: ArtifactRepository,
        costs: CostRepository,
        objects: ObjectStore,
        provider: SpriteProvider,
        tenant_id: str,
        production_id: str,
        project_id: str,
        provider_name: str,
        model_version: str,
        parameter_version: str,
        allowed_hosts: frozenset[str],
        worst_case_fen: int,
        thresholds: SpriteGateThresholds | None = None,
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
        self._thresholds = thresholds or SpriteGateThresholds()

    async def prepare_shot(
        self,
        *,
        package: LayerPackage,
        l1_input_hash: str,
        l1_checksums: Mapping[str, str],
        dialogues: tuple[tuple[str, int, int], ...],
        cancelled: bool = False,
    ) -> SpriteAttempt:
        shot_id = package.shot_id
        if cancelled:
            return _fallback(shot_id, "production-cancelled", input_hash="")
        face = face_layer(package)
        if face is None:
            return _fallback(shot_id, "missing-face", input_hash="")
        try:
            require_allowed_https(str(face.image_url), self._allowed_hosts)
        except ComicServiceError:
            return _fallback(shot_id, "url-not-allowlisted", input_hash="")
        head_checksum = l1_checksums.get(str(face.image_url))
        if head_checksum is None or len(head_checksum) != 64:
            return _fallback(shot_id, "checksum-mismatch", input_hash="")
        dialogue_present = bool(dialogues)
        reference_bounds = (face.bounds.x, face.bounds.y, face.bounds.width, face.bounds.height)
        reference_anchor = (face.anchor.x, face.anchor.y)
        input_hash = sprite_input_hash(
            project_id=self._project_id,
            shot_id=shot_id,
            l1_input_hash=l1_input_hash,
            head_checksum=head_checksum,
            canvas_width=package.canvas.width,
            canvas_height=package.canvas.height,
            reference_bounds=reference_bounds,
            reference_anchor=reference_anchor,
            dialogue_present=dialogue_present,
            model_version=self._model_version,
            parameter_version=self._parameter_version,
            threshold_version=self._thresholds.version,
        )
        artifact_id = f"l2:{self._production_id}:{input_hash[:32]}"
        claim = await self._artifacts.claim(
            tenant_id=self._tenant_id,
            project_id=self._project_id,
            stage="layer-l2",
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
        required = required_state_keys(dialogue_present=dialogue_present)
        if artifact.provider_request_id:
            reconciled = await self._provider.reconcile(artifact.provider_request_id)
            if reconciled is not None:
                return await self._accept(
                    artifact,
                    reconciled,
                    package=package,
                    face=face,
                    input_hash=input_hash,
                    required=required,
                    dialogue_present=dialogue_present,
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
            generation = await self._generate(
                artifact.artifact_id,
                shot_id=shot_id,
                source_url=str(face.image_url),
                canvas_width=package.canvas.width,
                canvas_height=package.canvas.height,
                required=required,
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
            generation = reconciled
        except SpriteProviderError as exc:
            reason = exc.code if exc.permanent else "provider-temporary"
            return await self._finish(
                artifact,
                reason=reason,
                asset_set=None,
                warnings=(),
                cost_fen=0,
                settle=False,
                uploaded=(),
            )
        return await self._accept(
            artifact,
            generation,
            package=package,
            face=face,
            input_hash=input_hash,
            required=required,
            dialogue_present=dialogue_present,
        )

    async def _generate(
        self,
        request_id: str,
        *,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        required: tuple[str, ...],
        cancelled: bool,
    ) -> SpriteGeneration:
        attempt = 0
        while True:
            try:
                return await self._provider.generate(
                    request_id=request_id,
                    shot_id=shot_id,
                    source_url=source_url,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                    model_version=self._model_version,
                    parameter_version=self._parameter_version,
                    required_states=required,
                )
            except ProviderTimeout:
                raise
            except SpriteProviderError as exc:
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
                    raise SpriteProviderError(exc.code, permanent=True) from exc

    async def _accept(
        self,
        artifact: ArtifactRow,
        generation: SpriteGeneration,
        *,
        package: LayerPackage,
        face: Layer,
        input_hash: str,
        required: tuple[str, ...],
        dialogue_present: bool,
    ) -> SpriteAttempt:
        if generation.cost_fen > self._worst_case_fen:
            await self._costs.mark_reconciliation(
                artifact.artifact_id,
                generation.provider_request_id,
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
        reference_bounds = (face.bounds.x, face.bounds.y, face.bounds.width, face.bounds.height)
        reference_anchor = (face.anchor.x, face.anchor.y)
        normalized, missing, warnings = _collect_states(
            generation,
            required=required,
            reference_bounds=reference_bounds,
            reference_anchor=reference_anchor,
            max_bounds_drift=self._thresholds.max_bounds_drift_px,
            max_anchor_drift=self._thresholds.max_anchor_drift,
        )
        if not normalized and not generation.states and not generation.missing:
            return await self._finish(
                artifact,
                reason="partial-response",
                asset_set=None,
                warnings=tuple(warnings),
                cost_fen=generation.cost_fen,
                settle=True,
                uploaded=(),
            )
        uploaded, upload_reason = await self._upload(artifact, normalized)
        if upload_reason is not None or uploaded is None:
            return await self._finish(
                artifact,
                reason=upload_reason or "checksum-mismatch",
                asset_set=None,
                warnings=tuple(warnings),
                cost_fen=generation.cost_fen,
                settle=True,
                uploaded=(),
            )
        asset_set = _asset_set(
            project_id=self._project_id,
            shot_id=str(artifact.shot_id),
            canvas_width=package.canvas.width,
            canvas_height=package.canvas.height,
            reference_layer_id=face.layer_id,
            uploaded=uploaded,
            missing=missing,
            dialogue_present=dialogue_present,
            warnings=warnings,
            model_version=self._model_version,
            input_hash=input_hash,
        )
        return await self._finish(
            artifact,
            reason=None,
            asset_set=asset_set,
            warnings=tuple(warnings),
            cost_fen=generation.cost_fen,
            settle=True,
            uploaded=uploaded,
        )

    async def _upload(
        self,
        artifact: ArtifactRow,
        states: list[_NormalizedState],
    ) -> tuple[list[tuple[_NormalizedState, str, str]] | None, str | None]:
        stored: list[tuple[_NormalizedState, str, str]] = []
        for state in states:
            digest = hashlib.sha256(state.image).hexdigest()
            key = artifact_object_key(
                tenant_id=self._tenant_id,
                production_id=self._production_id,
                stage="layer-l2",
                name=f"{artifact.shot_id}-{state.part}-{state.semantic}",
                checksum=digest,
            )
            try:
                written = await self._objects.put_verified(
                    key,
                    state.image,
                    content_type="image/png",
                )
                confirmed = await self._objects.checksum(key)
            except ValueError:
                return None, "checksum-mismatch"
            if written != digest or confirmed != digest:
                return None, "checksum-mismatch"
            url = self._objects.stable_url(key)
            try:
                require_allowed_https(url, self._allowed_hosts)
            except ComicServiceError:
                return None, "url-not-allowlisted"
            stored.append((state, url, digest))
        return stored, None

    async def _finish(
        self,
        artifact: ArtifactRow,
        *,
        reason: str | None,
        asset_set: SpriteAssetSet | None,
        warnings: tuple[str, ...],
        cost_fen: int,
        settle: bool,
        uploaded: (
            tuple[tuple[_NormalizedState, str, str], ...]
            | list[tuple[_NormalizedState, str, str]]
        ),
    ) -> SpriteAttempt:
        diagnostics: dict[str, object] = {
            "outcome": "ready" if asset_set is not None else "fallback",
            "reason": reason,
            "warnings": list(warnings),
            "thresholdVersion": self._thresholds.version,
            "modelVersion": self._model_version,
            "parameterVersion": self._parameter_version,
            "shotId": artifact.shot_id,
        }
        urls: list[str] = []
        checksums: list[str] = []
        if asset_set is not None:
            diagnostics["assetSet"] = asset_set.wire()
            urls = [url for _state, url, _digest in uploaded]
            checksums = [digest for _state, _url, digest in uploaded]
        if not urls:
            body = stable_stringify(diagnostics).encode()
            digest = hashlib.sha256(body).hexdigest()
            key = artifact_object_key(
                tenant_id=self._tenant_id,
                production_id=self._production_id,
                stage="layer-l2",
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
                    "sprite diagnostic checksum mismatch",
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
        return SpriteAttempt(
            shot_id=str(artifact.shot_id),
            asset_set=asset_set,
            artifact_id=artifact.artifact_id,
            input_hash=artifact.input_hash,
            downgrade_reason=None if asset_set is not None else reason,
            warnings=warnings,
        )


def face_layer(package: LayerPackage) -> Layer | None:
    """L1 names the face plate `head`. Stage D does not run segmentation again."""

    for layer in package.layers:
        if layer.semantic == "head":
            return layer
    return None


def sprite_input_hash(
    *,
    project_id: str,
    shot_id: str,
    l1_input_hash: str,
    head_checksum: str,
    canvas_width: int,
    canvas_height: int,
    reference_bounds: tuple[float, float, float, float],
    reference_anchor: tuple[float, float],
    dialogue_present: bool,
    model_version: str,
    parameter_version: str,
    threshold_version: str,
) -> str:
    x, y, width, height = reference_bounds
    return hash_content(
        {
            "canvas": {"height": canvas_height, "width": canvas_width},
            "catalogVersion": SPRITE_CATALOG_VERSION,
            "dialoguePresent": dialogue_present,
            "headChecksum": head_checksum,
            "l1InputHash": l1_input_hash,
            "modelVersion": model_version,
            "parameterVersion": parameter_version,
            "projectId": project_id,
            "referenceAnchor": {"x": reference_anchor[0], "y": reference_anchor[1]},
            "referenceBounds": {"height": height, "width": width, "x": x, "y": y},
            "requiredStates": list(required_state_keys(dialogue_present=dialogue_present)),
            "schemaVersion": 1,
            "shotId": shot_id,
            "thresholdVersion": threshold_version,
        }
    )


def png_header(image: bytes) -> _PngHeader | None:
    if len(image) < 26 or not image.startswith(_PNG) or image[12:16] != b"IHDR":
        return None
    width = int.from_bytes(image[16:20], "big")
    height = int.from_bytes(image[20:24], "big")
    if width <= 0 or height <= 0:
        return None
    return _PngHeader(width=width, height=height, color_type=image[25])


def _collect_states(
    generation: SpriteGeneration,
    *,
    required: tuple[str, ...],
    reference_bounds: tuple[float, float, float, float],
    reference_anchor: tuple[float, float],
    max_bounds_drift: float,
    max_anchor_drift: float,
) -> tuple[list[_NormalizedState], list[str], list[str]]:
    warnings = list(generation.warnings)
    unavailable: set[str] = set()
    for token in generation.missing:
        if token in _KNOWN_STATES:
            unavailable.add(token)
        else:
            warnings.append("unknown-semantic")
    buckets: dict[str, list[tuple[ProviderSpriteState, _PngHeader]]] = {}
    for state in generation.states:
        key = state_key(state.part, state.semantic)
        if key not in _KNOWN_STATES:
            warnings.append("unknown-semantic")
            continue
        if key in unavailable:
            continue
        header = png_header(state.image)
        if header is None or header.color_type not in {4, 6}:
            warnings.append("corrupt-alpha")
            unavailable.add(key)
            continue
        buckets.setdefault(key, []).append((state, header))
    for key, items in list(buckets.items()):
        if len(items) > 1:
            warnings.append("duplicate-semantic")
            del buckets[key]
            unavailable.add(key)
    normalized: list[_NormalizedState] = []
    order = list(required)
    if "mouth:closed" in required:
        order.append("mouth:half")
    for key in order:
        items = buckets.get(key)
        if not items:
            continue
        state, header = items[0]
        bounds = _snap(state.bounds, reference_bounds, max_bounds_drift)
        anchor = _snap(state.anchor, reference_anchor, max_anchor_drift)
        if len(bounds) < 4 or bounds[2] <= 0 or bounds[3] <= 0:
            warnings.append("partial-response")
            unavailable.add(key)
            continue
        normalized.append(
            _NormalizedState(
                part=state.part,
                semantic=state.semantic,
                image=state.image,
                width=header.width,
                height=header.height,
                color_type=header.color_type,
                x=bounds[0],
                y=bounds[1],
                bounds_width=bounds[2],
                bounds_height=bounds[3],
                anchor_x=anchor[0],
                anchor_y=anchor[1],
            )
        )
    present = {state_key(item.part, item.semantic) for item in normalized}
    missing = [key for key in required if key not in present]
    for key in unavailable:
        if key not in missing:
            missing.append(key)
    return normalized, missing, list(dict.fromkeys(warnings))


def _snap(
    provided: tuple[float, float, float, float] | tuple[float, float] | None,
    reference: tuple[float, ...],
    limit: float,
) -> tuple[float, ...]:
    if provided is None or _distance(provided, reference) - limit <= 1e-6:
        return reference
    return provided


def _distance(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return max(abs(item - other) for item, other in zip(left, right, strict=False))


def _asset_set(
    *,
    project_id: str,
    shot_id: str,
    canvas_width: int,
    canvas_height: int,
    reference_layer_id: str,
    uploaded: list[tuple[_NormalizedState, str, str]],
    missing: list[str],
    dialogue_present: bool,
    warnings: list[str],
    model_version: str,
    input_hash: str,
) -> SpriteAssetSet:
    required = set(required_state_keys(dialogue_present=dialogue_present))
    present = {state_key(state.part, state.semantic) for state, _url, _digest in uploaded}
    return SpriteAssetSet(
        project_id=project_id,  # type: ignore[arg-type]
        shot_id=shot_id,  # type: ignore[arg-type]
        canvas=LayerCanvas(width=canvas_width, height=canvas_height),
        reference_layer_id=reference_layer_id,
        states=[
            SpriteStateAsset(
                shot_id=shot_id,  # type: ignore[arg-type]
                part=state.part,  # type: ignore[arg-type]
                semantic=state.semantic,  # type: ignore[arg-type]
                asset_id=sprite_asset_id(shot_id, state.part, state.semantic),
                image_url=url,  # type: ignore[arg-type]
                width=state.width,
                height=state.height,
                bounds=LayerBounds(
                    x=state.x,
                    y=state.y,
                    width=state.bounds_width,
                    height=state.bounds_height,
                ),
                anchor=LayerAnchor(x=state.anchor_x, y=state.anchor_y),
                checksum=digest,
                model_version=model_version,
                input_hash=input_hash,
                color_type=state.color_type,
            )
            for state, url, digest in uploaded
        ],
        missing=missing,
        partial=not required.issubset(present) or bool(missing),
        dialogue_present=dialogue_present,
        warnings=warnings,
    )


def _fallback(
    shot_id: str,
    reason: str,
    *,
    input_hash: str,
    artifact_id: str | None = None,
) -> SpriteAttempt:
    return SpriteAttempt(
        shot_id=shot_id,
        asset_set=None,
        artifact_id=artifact_id,
        input_hash=input_hash,
        downgrade_reason=reason,
    )


def _pending(shot_id: str, input_hash: str, artifact_id: str) -> SpriteAttempt:
    return SpriteAttempt(
        shot_id=shot_id,
        asset_set=None,
        artifact_id=artifact_id,
        input_hash=input_hash,
        downgrade_reason="provider-reconciliation-pending",
        pending=True,
    )


def _from_completed(artifact: ArtifactRow) -> SpriteAttempt:
    payload = artifact.diagnostics.get("assetSet")
    asset_set = SpriteAssetSet.model_validate(payload) if isinstance(payload, dict) else None
    reason = artifact.diagnostics.get("reason")
    ready = asset_set is not None and artifact.diagnostics.get("outcome") == "ready"
    return SpriteAttempt(
        shot_id=str(artifact.shot_id),
        asset_set=asset_set if ready else None,
        artifact_id=artifact.artifact_id,
        input_hash=artifact.input_hash,
        downgrade_reason=None if ready else str(reason or "quality-failed"),
        warnings=tuple(artifact.diagnostics.get("warnings") or []),
    )
