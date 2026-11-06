from __future__ import annotations

import base64
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from app.config import get_settings
from app.services.workflow_snapshot_client import (
    WorkflowSnapshotClient,
    WorkflowSnapshotUnavailable,
)


@pytest.fixture
def consumer_urls() -> Iterator[None]:
    settings = get_settings()
    previous = (
        settings.internal_api_key,
        settings.consumer_blue_url,
        settings.consumer_green_url,
    )
    settings.internal_api_key = "internal-secret"
    settings.consumer_blue_url = "http://blue"
    settings.consumer_green_url = "http://green/"
    try:
        yield
    finally:
        (
            settings.internal_api_key,
            settings.consumer_blue_url,
            settings.consumer_green_url,
        ) = previous


def _response(status: int, payload: Any, url: str) -> httpx.Response:
    response = httpx.Response(status, json=payload)
    response.request = httpx.Request("GET", url)
    return response


def _scripted_client(
    monkeypatch: pytest.MonkeyPatch,
    script: list[tuple[int, Any]],
) -> list[tuple[str, dict[str, str]]]:
    calls: list[tuple[str, dict[str, str]]] = []

    class _Client:
        def __init__(self, *, timeout: float) -> None:
            assert timeout == 5.0

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

        async def get(self, url: str, headers: dict[str, str] | None = None) -> httpx.Response:
            calls.append((url, dict(headers or {})))
            status, payload = script.pop(0)
            return _response(status, payload, url)

    monkeypatch.setattr("app.services.workflow_snapshot_client.httpx.AsyncClient", _Client)
    return calls


def _valid(flow_task_id: str = "task-1", **extra: Any) -> dict[str, Any]:
    snapshot = {
        "flow_run_id": "run-1",
        "flow_task_id": flow_task_id,
        "protocol_version": 2,
        "status": "running",
    }
    snapshot.update(extra)
    return snapshot


@pytest.mark.asyncio
async def test_blue_404_uses_the_first_valid_green_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    consumer_urls: None,
) -> None:
    del consumer_urls
    calls = _scripted_client(
        monkeypatch,
        [
            (404, {"detail": "workflow snapshot not found"}),
            (200, _valid(status="running", source="green")),
        ],
    )

    snapshot = await WorkflowSnapshotClient.fetch("task-1")

    assert snapshot["source"] == "green"
    assert snapshot["protocol_version"] == 2
    assert [url for url, _headers in calls] == [
        "http://blue/api/internal/workflow/task-1/snapshot",
        "http://green/api/internal/workflow/task-1/snapshot",
    ]
    authorization = calls[0][1]["Authorization"]
    assert base64.b64decode(authorization).decode("utf-8") == "internal-secret"
    assert not authorization.lower().startswith("bearer ")


@pytest.mark.asyncio
async def test_invalid_snapshot_tries_the_next_consumer(
    monkeypatch: pytest.MonkeyPatch,
    consumer_urls: None,
) -> None:
    del consumer_urls
    calls = _scripted_client(
        monkeypatch,
        [
            (200, ["not-an-object"]),
            (200, _valid(source="green")),
        ],
    )

    snapshot = await WorkflowSnapshotClient.fetch("task-1")

    assert snapshot["source"] == "green"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_duplicate_consumer_url_is_requested_once(
    monkeypatch: pytest.MonkeyPatch,
    consumer_urls: None,
) -> None:
    del consumer_urls
    settings = get_settings()
    settings.consumer_blue_url = "http://blue/"
    settings.consumer_green_url = "http://blue"
    calls = _scripted_client(monkeypatch, [(404, {"detail": "missing"})])

    with pytest.raises(WorkflowSnapshotUnavailable, match="no consumer URL"):
        await WorkflowSnapshotClient.fetch("task-1")

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_both_consumers_failing_raises_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    consumer_urls: None,
) -> None:
    del consumer_urls
    _scripted_client(
        monkeypatch,
        [
            (503, {"detail": "down"}),
            (200, _valid(protocol_version=1)),
        ],
    )

    with pytest.raises(WorkflowSnapshotUnavailable):
        await WorkflowSnapshotClient.fetch("task-1")


@pytest.mark.asyncio
async def test_missing_consumer_urls_raise_without_a_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    previous = (settings.consumer_blue_url, settings.consumer_green_url)
    settings.consumer_blue_url = ""
    settings.consumer_green_url = ""
    calls = _scripted_client(monkeypatch, [])
    try:
        with pytest.raises(WorkflowSnapshotUnavailable, match="no consumer URL"):
            await WorkflowSnapshotClient.fetch("task-1")
    finally:
        settings.consumer_blue_url, settings.consumer_green_url = previous

    assert calls == []
