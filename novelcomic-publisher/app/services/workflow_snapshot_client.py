"""Fetch a Consumer workflow snapshot from the blue deployment, then green."""

from __future__ import annotations

import base64
from typing import Any

import httpx

from app.config import get_settings


class WorkflowSnapshotUnavailable(Exception):
    pass


class WorkflowSnapshotClient:
    @classmethod
    async def fetch(cls, flow_task_id: str) -> dict[str, Any]:
        settings = get_settings()
        authorization = base64.b64encode(settings.internal_api_key.encode("utf-8")).decode("ascii")
        base_urls = list(
            dict.fromkeys(
                url.rstrip("/")
                for url in (settings.consumer_blue_url, settings.consumer_green_url)
                if url
            )
        )
        last_error: Exception | None = None
        async with httpx.AsyncClient(timeout=5.0) as client:
            for base_url in base_urls:
                try:
                    response = await client.get(
                        f"{base_url}/api/internal/workflow/{flow_task_id}/snapshot",
                        headers={"Authorization": authorization},
                    )
                    if response.status_code == 404:
                        continue
                    response.raise_for_status()
                    snapshot = response.json()
                    if not isinstance(snapshot, dict):
                        raise ValueError("consumer snapshot is not a JSON object")
                    if snapshot.get("flow_task_id") != flow_task_id:
                        raise ValueError("consumer snapshot flow_task_id mismatch")
                    if snapshot.get("protocol_version") != 2:
                        raise ValueError("consumer snapshot protocol_version mismatch")
                    return snapshot
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = exc
        raise WorkflowSnapshotUnavailable(
            f"workflow snapshot is unavailable: {last_error or 'no consumer URL'}"
        )
