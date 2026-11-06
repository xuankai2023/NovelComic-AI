"""Deterministic L1 gate. It never calls a model or invents missing files."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

from ..contracts.layer_package import (
    L1_CHARACTER_SEMANTICS,
    LayerPackage,
)

_SHA256 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True, slots=True)
class LayerGateThresholds:
    version: str = "layer-gate-v1"
    max_recomposition_score: float = 0.35
    max_alpha_hole_ratio: float = 0.05
    max_edge_artifact_score: float = 0.08
    min_confidence_warning: float = 0.5


@dataclass(frozen=True, slots=True)
class LayerGateResult:
    decision: str
    reason_code: str | None
    warnings: tuple[str, ...]
    threshold_version: str

    @property
    def accepted(self) -> bool:
        return self.decision == "accepted"


def evaluate_layers(
    package: LayerPackage,
    *,
    expected_canvas: tuple[int, int],
    checksums: Mapping[str, str | None],
    expected_checksums: Mapping[str, str] | None = None,
    thresholds: LayerGateThresholds | None = None,
) -> LayerGateResult:
    """Accept a package or require fallback. The package is not modified."""

    rules = thresholds or LayerGateThresholds()
    failures: list[str] = []
    warnings: list[str] = []
    if package.diagnostics.requires_fallback:
        failures.append("provider-requires-fallback")

    expected_width, expected_height = expected_canvas
    if package.canvas.width != expected_width or package.canvas.height != expected_height:
        failures.append("canvas-mismatch")

    identities = [layer.layer_id for layer in package.layers]
    if len(identities) != len(set(identities)):
        failures.append("duplicate-layer-id")
    semantics = [layer.semantic for layer in package.layers]
    if len(semantics) != len(set(semantics)):
        failures.append("duplicate-semantic")

    failures.extend(_stack_failures(package))
    failures.extend(_geometry_failures(package))
    if not any(layer.semantic == "background" for layer in package.layers):
        failures.append("missing-required-layer")
    elif not any(layer.semantic in L1_CHARACTER_SEMANTICS for layer in package.layers):
        failures.append("missing-required-layer")

    for layer in package.layers:
        url = str(layer.image_url)
        actual = checksums.get(url)
        if url not in checksums or actual is None or not _SHA256.fullmatch(actual):
            failures.append("url-unreadable")
            continue
        expected = None if expected_checksums is None else expected_checksums.get(url)
        if expected is not None and expected != actual:
            failures.append("checksum-mismatch")
        if layer.confidence < rules.min_confidence_warning:
            warnings.append("low-confidence")

    scores = package.diagnostics
    if scores.recomposition_score > rules.max_recomposition_score:
        failures.append("recomposition-failed")
    if scores.alpha_hole_ratio > rules.max_alpha_hole_ratio:
        failures.append("alpha-hole")
    if scores.edge_artifact_score > rules.max_edge_artifact_score:
        failures.append("edge-artifact")
    warnings.extend(package.diagnostics.warnings)

    unique_failures = tuple(dict.fromkeys(failures))
    unique_warnings = tuple(
        code for code in dict.fromkeys(warnings) if code not in unique_failures
    )
    if unique_failures:
        return LayerGateResult(
            decision="fallback",
            reason_code=unique_failures[0],
            warnings=unique_failures[1:] + unique_warnings,
            threshold_version=rules.version,
        )
    return LayerGateResult(
        decision="accepted",
        reason_code=None,
        warnings=unique_warnings,
        threshold_version=rules.version,
    )


def _stack_failures(package: LayerPackage) -> list[str]:
    background = [layer for layer in package.layers if layer.semantic == "background"]
    characters = [layer for layer in package.layers if layer.semantic in L1_CHARACTER_SEMANTICS]
    foreground = [layer for layer in package.layers if layer.semantic == "foreground"]
    bodies = [layer for layer in package.layers if layer.semantic == "body"]
    failures: list[str] = []
    if background and characters:
        back = min(layer.z_index for layer in background)
        if any(layer.z_index <= back for layer in characters):
            failures.append("occlusion-error")
    if foreground and bodies:
        front = min(layer.z_index for layer in foreground)
        if any(layer.z_index >= front for layer in bodies):
            failures.append("occlusion-error")
    return failures


def _geometry_failures(package: LayerPackage) -> list[str]:
    failures: list[str] = []
    width = package.canvas.width
    height = package.canvas.height
    for layer in package.layers:
        bounds = layer.bounds
        if (
            bounds.x < 0
            or bounds.y < 0
            or bounds.x + bounds.width > width
            or bounds.y + bounds.height > height
        ):
            failures.append("bounds-mismatch")
        anchor = layer.anchor
        if anchor.x < 0 or anchor.x > 1 or anchor.y < 0 or anchor.y > 1:
            failures.append("anchor-out-of-range")
    return failures
