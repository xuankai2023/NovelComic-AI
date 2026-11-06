"""Remotion HTTP mapping. A 200 response does not commit a draft."""

from __future__ import annotations

import json

import httpx
import pytest

from novelcomic_agent.comic.canonical import project_content_hash
from novelcomic_agent.comic.contracts.errors import ComicServiceError
from novelcomic_agent.comic.rendering.remotion_client import RemotionHttpClient
from tests.comic_support import empty_project


def _client(handler) -> RemotionHttpClient:
    return RemotionHttpClient(
        "http://remotion.test",
        allowed_hosts=frozenset({"cdn.example"}),
        transport=httpx.MockTransport(handler),
    )


async def test_success_returns_a_local_content_hash_without_a_repository() -> None:
    project = empty_project()
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"type": "success", "project": project})

    client = _client(handler)
    result = await client.apply(
        client_request_id="compose:shot/edit:1",  # type: ignore[arg-type]
        expected_revision=0,
        project=project,
        command_name="shot/edit",
        payload={"shotId": "shot-a"},
    )
    await client.aclose()
    assert result.content_hash == project_content_hash(project)
    assert seen == ["/api/compose/shot/edit"]


async def test_pad_404_is_a_non_retryable_blocker() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/compose/project/pad"
        return httpx.Response(404, json={"message": "missing"})

    client = _client(handler)
    with pytest.raises(ComicServiceError) as caught:
        await client.apply(
            client_request_id="compose:project/pad:1",  # type: ignore[arg-type]
            expected_revision=0,
            project=empty_project(),
            command_name="project/pad",
            payload={"minimumDurationInFrames": 150},
        )
    await client.aclose()
    assert caught.value.code == "COMPOSE_FAILED"
    assert caught.value.body.retryable is False
    assert caught.value.body.details == {"blocked": "project/pad", "command": "project/pad"}


async def test_remote_error_and_unlisted_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("expectedRevision") == 4:
            return httpx.Response(
                409,
                json={"type": "error", "code": "revision", "message": "stale"},
            )
        return httpx.Response(
            400,
            json={
                "type": "error",
                "code": "bad-shot",
                "message": "shot missing",
                "retryable": False,
                "shotId": "shot-a",
            },
        )

    client = _client(handler)
    with pytest.raises(ComicServiceError) as failed:
        await client.apply(
            client_request_id="compose:shot/edit:2",  # type: ignore[arg-type]
            expected_revision=0,
            project=empty_project(),
            command_name="shot/edit",
            payload={"shotId": "shot-a"},
        )
    assert failed.value.code == "COMPOSE_FAILED"
    assert failed.value.body.details["remoteCode"] == "bad-shot"
    assert failed.value.body.details["shotId"] == "shot-a"

    with pytest.raises(ComicServiceError) as conflict:
        await client.apply(
            client_request_id="compose:shot/edit:3",  # type: ignore[arg-type]
            expected_revision=4,
            project=empty_project(),
            command_name="shot/edit",
            payload={"shotId": "shot-a"},
        )
    assert conflict.value.code == "DRAFT_REVISION_CONFLICT"

    called = False

    def blocked(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"type": "success", "project": empty_project()})

    guarded = _client(blocked)
    with pytest.raises(ComicServiceError) as rejected:
        await guarded.apply(
            client_request_id="compose:image/sequence:1",  # type: ignore[arg-type]
            expected_revision=0,
            project=empty_project(),
            command_name="image/sequence",
            payload={"images": [{"url": "https://evil.example/a.png"}]},
        )
    await client.aclose()
    await guarded.aclose()
    assert rejected.value.code == "INVALID_REQUEST"
    assert called is False
