"""Request-scoped canvas snapshot for Agent tools.

This validates nodes and edges already present on the Agent request. It does
not read ``flow_run_state`` and it does not call the Consumer snapshot API.
"""

from __future__ import annotations

from typing import Any


def _is_object_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, dict) for item in value)


def _has_valid_snapshot_metadata(raw_snapshot: dict[str, Any]) -> bool:
    if raw_snapshot.get("schema_version") not in (1, 2):
        return False

    snapshot_hash = raw_snapshot.get("snapshot_hash")
    if not isinstance(snapshot_hash, str) or not snapshot_hash.strip():
        return False

    captured_at = raw_snapshot.get("captured_at_utc_ms")
    return isinstance(captured_at, (int, float)) and not isinstance(captured_at, bool)


def normalize_request_workflow_snapshot(
    raw_snapshot: object,
    flow_id: str | None,
) -> dict[str, Any] | None:
    """Return the request canvas, or None when it is not a usable snapshot."""

    if not isinstance(raw_snapshot, dict):
        return None
    if not _has_valid_snapshot_metadata(raw_snapshot):
        return None

    nodes = raw_snapshot.get("nodes")
    edges = raw_snapshot.get("edges")
    if not _is_object_list(nodes) or not _is_object_list(edges):
        return None

    snapshot_flow_id = raw_snapshot.get("flow_id") or raw_snapshot.get("workflow_id")
    if isinstance(snapshot_flow_id, str):
        snapshot_flow_id = snapshot_flow_id.strip()
    else:
        snapshot_flow_id = ""

    expected_flow_id = flow_id.strip() if isinstance(flow_id, str) and flow_id.strip() else ""
    if not snapshot_flow_id or not expected_flow_id or snapshot_flow_id != expected_flow_id:
        return None

    normalized: dict[str, Any] = {
        "flow_id": snapshot_flow_id,
        "nodes": nodes,
        "edges": edges,
    }
    for key in (
        "snapshot_hash",
        "schema_version",
        "captured_at",
        "captured_at_utc_ms",
        "project_name",
    ):
        value = raw_snapshot.get(key)
        if value is not None:
            normalized[key] = value
    return normalized


def apply_request_workflow_snapshot(
    payload: dict[str, Any],
    flow_id: str | None,
) -> dict[str, Any] | None:
    """Store only a normalized canvas snapshot on the Agent request payload."""

    normalized = normalize_request_workflow_snapshot(payload.get("workflow_snapshot"), flow_id)
    payload["workflow_snapshot"] = normalized
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        metadata.pop("workflow_snapshot", None)
    return normalized


def workflow_snapshot_from_context(
    request_context: dict[str, Any],
    flow_id: str,
) -> tuple[dict[str, Any] | None, str]:
    """Read a canvas snapshot from request context without fetching a run."""

    raw_snapshot = request_context.get("workflow_snapshot")
    if raw_snapshot is None:
        return None, "missing"
    if not isinstance(raw_snapshot, dict):
        return None, "invalid_type"
    if raw_snapshot.get("schema_version") not in (1, 2):
        return None, "invalid_schema"

    snapshot_flow_id = raw_snapshot.get("flow_id")
    if isinstance(snapshot_flow_id, str) and snapshot_flow_id.strip():
        if snapshot_flow_id.strip() != flow_id:
            return None, "flow_mismatch"
    else:
        return None, "missing_flow_id"

    snapshot_hash = raw_snapshot.get("snapshot_hash")
    captured_at = raw_snapshot.get("captured_at_utc_ms")
    if not isinstance(snapshot_hash, str) or not snapshot_hash.strip():
        return None, "missing_snapshot_hash"
    if not isinstance(captured_at, (int, float)) or isinstance(captured_at, bool):
        return None, "invalid_captured_at"

    nodes = raw_snapshot.get("nodes")
    edges = raw_snapshot.get("edges")
    if not _is_object_list(nodes) or not _is_object_list(edges):
        return None, "invalid_shape"

    return raw_snapshot, "hit"


def workflow_data_from_snapshot(snapshot: dict[str, Any], flow_id: str) -> dict[str, Any]:
    """Adapt a request canvas to nodes and edges. Run state is not included."""

    result: dict[str, Any] = {
        "flow_id": snapshot.get("flow_id") or flow_id,
        "nodes": snapshot.get("nodes", []),
        "edges": snapshot.get("edges", []),
    }
    project_name = snapshot.get("project_name")
    if isinstance(project_name, str) and project_name.strip():
        result["details"] = {"project_name": project_name.strip()}
    return result
