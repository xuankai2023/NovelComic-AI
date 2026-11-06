"""Stateless Remotion HTTP client. A 200 response is not a committed draft."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ..canonical import project_content_hash
from ..contracts.errors import ComicServiceError
from ..contracts.ids import CommandId
from ..drafts.apply_compose_command import ComposeResult
from ..url_policy import require_allowed_https

_PATHS = {
    "project/create": "/api/compose/project/create",
    "image/sequence": "/api/compose/image/sequence",
    "dialogue/add": "/api/compose/dialogue/add",
    "dialogue/voice": "/api/compose/dialogue/voice",
    "shot/edit": "/api/compose/shot/edit",
    "project/pad": "/api/compose/project/pad",
    "layers/import": "/api/compose/layers/import",
    "layers/restore-l0": "/api/compose/layers/restore-l0",
    "item/motion": "/api/compose/item/motion",
    "project/validate": "/api/compose/project/validate",
    "project/summary": "/api/compose/project/summary",
    "project/plan-batches": "/api/compose/project/plan-batches",
    "project/render-batches": "/api/compose/project/render-batches",
    "project/contact-sheet": "/api/compose/project/contact-sheet",
    "project/preview-frame": "/api/compose/project/preview-frame",
    "project/export-package": "/api/compose/project/export-package",
    "render/progress": "/api/progress",
}


@dataclass(frozen=True, slots=True)
class ValidationReport:
    valid: bool
    issues: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class ContactFrame:
    shot_id: str
    frame: int


@dataclass(frozen=True, slots=True)
class StillFrame:
    url: str | None = None
    task_id: str | None = None
    body: bytes | None = None


@dataclass(frozen=True, slots=True)
class RenderProgress:
    status: str
    progress: float
    output_url: str | None = None
    output_bytes: bytes | None = None
    error: str | None = None
    actual_cost_fen: int | None = None


class RenderingGateway(Protocol):
    async def create_project(
        self,
        *,
        width: int,
        height: int,
        fps: int,
        client_request_id: str,
    ) -> dict[str, Any]:
        """Create an empty project. The caller stores it as revision zero."""

    async def apply(
        self,
        *,
        client_request_id: CommandId,
        expected_revision: int,
        project: dict[str, Any],
        command_name: str,
        payload: dict[str, Any],
    ) -> ComposeResult:
        """Apply one write command without persisting the draft."""

    async def validate_project(self, project: dict[str, Any]) -> ValidationReport:
        """Read-only project validation."""

    async def summarize_project(self, project: dict[str, Any]) -> dict[str, Any]:
        """Read-only project summary."""

    async def plan_batches(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        """Return output batches for the committed project."""

    async def render_batches(
        self,
        project: dict[str, Any],
        *,
        retry_batch_ids: list[str],
    ) -> list[dict[str, Any]]:
        """Submit only the named batches."""

    async def render_progress(self, *, bucket_name: str, render_id: str) -> RenderProgress:
        """Poll one existing render."""

    async def contact_sheet(self, project: dict[str, Any]) -> list[ContactFrame]:
        """Return the frame plan. This response is not a contact-sheet image."""

    async def preview_frame(
        self,
        project: dict[str, Any],
        *,
        frame: int,
        width: int = 480,
    ) -> StillFrame:
        """Render one low-resolution still."""

    async def export_package(
        self,
        *,
        project_id: str,
        project: dict[str, Any],
        batches: list[dict[str, Any]],
        files: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Ask Remotion for a manifest. The agent still builds the ZIP."""


class RemotionHttpClient:
    """Maps Remotion HTTP errors onto comic service errors and keeps URL allowlists."""

    def __init__(
        self,
        base_url: str,
        *,
        allowed_hosts: frozenset[str],
        timeout_seconds: float = 120,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._allowed_hosts = allowed_hosts
        self._client = httpx.AsyncClient(
            timeout=timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def create_project(
        self,
        *,
        width: int,
        height: int,
        fps: int,
        client_request_id: str,
    ) -> dict[str, Any]:
        body = await self._post(
            "project/create",
            {
                "clientRequestId": client_request_id,
                "compositionWidth": width,
                "compositionHeight": height,
                "fps": fps,
            },
        )
        project = body.get("project")
        if not isinstance(project, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "project/create did not return a project",
                retryable=True,
            )
        return project

    async def apply(
        self,
        *,
        client_request_id: CommandId,
        expected_revision: int,
        project: dict[str, Any],
        command_name: str,
        payload: dict[str, Any],
    ) -> ComposeResult:
        if command_name not in {
            "image/sequence",
            "dialogue/add",
            "dialogue/voice",
            "shot/edit",
            "project/pad",
            "layers/import",
            "layers/restore-l0",
            "item/motion",
        }:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "compose command is not a write",
                retryable=False,
                details={"command": command_name},
            )
        body = await self._post(
            command_name,
            {
                "clientRequestId": client_request_id,
                "expectedRevision": expected_revision,
                "project": project,
                **payload,
            },
        )
        new_project = body.get("project")
        if not isinstance(new_project, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "compose write did not return a project",
                retryable=True,
                details={"command": command_name},
            )
        return ComposeResult(
            project=new_project,
            content_hash=project_content_hash(new_project),
        )

    async def validate_project(self, project: dict[str, Any]) -> ValidationReport:
        body = await self._post("project/validate", {"project": project})
        issues = body.get("issues") or []
        return ValidationReport(valid=bool(body.get("valid")), issues=tuple(issues))

    async def summarize_project(self, project: dict[str, Any]) -> dict[str, Any]:
        return await self._post("project/summary", {"project": project})

    async def plan_batches(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        body = await self._post("project/plan-batches", {"project": project})
        batches = body.get("batches")
        if not isinstance(batches, list):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "plan-batches did not return batches",
                retryable=True,
            )
        return batches

    async def render_batches(
        self,
        project: dict[str, Any],
        *,
        retry_batch_ids: list[str],
    ) -> list[dict[str, Any]]:
        body = await self._post(
            "project/render-batches",
            {"project": project, "retryBatchIds": retry_batch_ids},
        )
        results = body.get("results")
        if not isinstance(results, list):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "render-batches did not return results",
                retryable=True,
            )
        return results

    async def render_progress(self, *, bucket_name: str, render_id: str) -> RenderProgress:
        body = await self._post(
            "render/progress",
            {"bucketName": bucket_name, "renderId": render_id},
        )
        status = str(body.get("type") or "")
        if status == "done":
            return RenderProgress(
                status="done",
                progress=1,
                output_url=body.get("outputFile"),
                output_bytes=None,
            )
        if status == "error":
            return RenderProgress(status="error", progress=0, error=str(body.get("error") or ""))
        return RenderProgress(
            status="in-progress",
            progress=float(body.get("overallProgress") or 0),
        )

    async def contact_sheet(self, project: dict[str, Any]) -> list[ContactFrame]:
        body = await self._post("project/contact-sheet", {"project": project})
        if any(key in body for key in ("image", "imageBase64", "png")):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "contact-sheet returned image bytes instead of a frame plan",
                retryable=False,
            )
        frames = body.get("frames")
        if not isinstance(frames, list):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "contact-sheet did not return frames",
                retryable=True,
            )
        planned: list[ContactFrame] = []
        for frame in frames:
            if not isinstance(frame, dict) or "shotId" not in frame or "frame" not in frame:
                raise ComicServiceError(
                    "COMPOSE_FAILED",
                    "contact-sheet frame plan is incomplete",
                    retryable=True,
                )
            planned.append(ContactFrame(shot_id=str(frame["shotId"]), frame=int(frame["frame"])))
        return planned

    async def preview_frame(
        self,
        project: dict[str, Any],
        *,
        frame: int,
        width: int = 480,
    ) -> StillFrame:
        body = await self._post(
            "project/preview-frame",
            {"project": project, "frame": frame, "width": width, "format": "png"},
        )
        url = body.get("url")
        task_id = body.get("taskId")
        if not url and not task_id:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "preview-frame did not return a url or task id",
                retryable=True,
            )
        return StillFrame(
            url=str(url) if url else None,
            task_id=str(task_id) if task_id else None,
        )

    async def export_package(
        self,
        *,
        project_id: str,
        project: dict[str, Any],
        batches: list[dict[str, Any]],
        files: list[dict[str, Any]],
    ) -> dict[str, Any]:
        body = await self._post(
            "project/export-package",
            {
                "projectId": project_id,
                "project": project,
                "batches": batches,
                "files": files,
            },
        )
        manifest = body.get("manifest")
        if not isinstance(manifest, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "export-package did not return a manifest",
                retryable=True,
            )
        return {"manifest": manifest}

    async def _post(self, command_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        _reject_unlisted_urls(payload, self._allowed_hosts)
        path = _PATHS[command_name]
        try:
            response = await self._client.post(f"{self._base_url}{path}", json=payload)
        except httpx.TimeoutException as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "remotion request timed out",
                retryable=True,
                details={"command": command_name},
            ) from exc
        except httpx.HTTPError as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "remotion request failed",
                retryable=True,
                details={"command": command_name},
            ) from exc
        if response.status_code == 404 and command_name == "project/pad":
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "project/pad is a launch blocker while the project is shorter than 5 seconds",
                retryable=False,
                details={"blocked": "project/pad", "command": command_name},
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "remotion returned a non-JSON response",
                retryable=True,
                details={"command": command_name},
            ) from exc
        if not isinstance(body, dict):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "remotion returned an unexpected payload",
                retryable=True,
                details={"command": command_name},
            )
        if response.status_code == 409:
            raise ComicServiceError(
                "DRAFT_REVISION_CONFLICT",
                str(body.get("message") or "remotion revision conflict"),
                retryable=True,
                details={"command": command_name, "remoteCode": body.get("code")},
            )
        if response.status_code >= 400 or (
            body.get("type") == "error" and command_name != "render/progress"
        ):
            raise ComicServiceError(
                "COMPOSE_FAILED",
                str(body.get("message") or body.get("error") or "remotion rejected the command"),
                retryable=bool(body.get("retryable")),
                details={
                    "command": command_name,
                    "remoteCode": body.get("code"),
                    "shotId": body.get("shotId"),
                    "itemId": body.get("itemId"),
                    "assetId": body.get("assetId"),
                },
            )
        return body


def _reject_unlisted_urls(value: Any, allowed_hosts: frozenset[str]) -> None:
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        require_allowed_https(value, allowed_hosts)
        return
    if isinstance(value, dict):
        for item in value.values():
            _reject_unlisted_urls(item, allowed_hosts)
    elif isinstance(value, list):
        for item in value:
            _reject_unlisted_urls(item, allowed_hosts)
