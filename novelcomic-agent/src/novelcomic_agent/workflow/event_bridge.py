"""Run snapshots used by workflow select. The snapshot has no user_id."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RunSnapshot:
    flow_task_id: str
    ws_id: str
    nodes: list[dict] = field(default_factory=list)
    edges: list[dict] = field(default_factory=list)
    session_id: str = ""
    flow_id: str = ""


_snapshots: dict[str, RunSnapshot] = {}


def store_run_snapshot(snapshot: RunSnapshot) -> None:
    _snapshots[snapshot.flow_task_id] = snapshot


def get_run_snapshot(flow_task_id: str) -> RunSnapshot | None:
    return _snapshots.get(flow_task_id)


def clear_run_snapshots() -> None:
    _snapshots.clear()
