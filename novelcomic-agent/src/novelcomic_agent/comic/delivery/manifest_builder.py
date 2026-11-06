"""Deterministic manifest. ``generatedAt`` is display-only and stays out of the package hash."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from ..canonical import hash_content, stable_stringify
from ..contracts.delivery_manifest import (
    DeliveryFileEntry,
    DeliveryPackageManifest,
    OutputBatch,
)
from ..persistence.rows import ArtifactRow, BatchRow, ProductionRow
from ..storage.key_layout import delivery_object_key
from ..storage.object_store import ObjectStore

_OPTIONAL = ("source", "panel", "layer", "audio", "subtitle", "project", "preview")
_SIGNED = ("expires=", "signature=", "x-amz-", "signed.")


@dataclass(frozen=True, slots=True)
class _Stored:
    path: str
    category: str
    order: int
    object_key: str
    checksum: str
    size_bytes: int


async def build_manifest(
    *,
    row: ProductionRow,
    project: dict[str, Any],
    content_hash: str,
    artifacts: list[ArtifactRow],
    batches: list[BatchRow],
    objects: ObjectStore,
    generated_at: str,
) -> DeliveryPackageManifest:
    stored: list[_Stored] = []
    stored.extend(await _artifact_files(row, artifacts, content_hash, objects))
    videos, missing_videos = await _videos(batches, content_hash, objects)
    stored.extend(videos)
    project_bytes = stable_stringify(project).encode()
    stored.append(
        await _put_generated(
            row, objects, "project-json", "project/project.json", "project", project_bytes
        )
    )
    subtitle = _subtitle_text(row, int(project.get("fps") or 30))
    if subtitle:
        stored.append(
            await _put_generated(
                row,
                objects,
                "subtitles",
                "subtitles/dialogue.srt",
                "subtitle",
                subtitle.encode(),
            )
        )
    videos = [item for item in stored if item.category == "final-video"]
    videos.sort(key=lambda item: item.path)
    play_order = [item.path for item in videos]
    play_bytes = stable_stringify({"playOrder": play_order}).encode()
    stored.append(
        await _put_generated(row, objects, "play-order", "play-order.json", "manifest", play_bytes)
    )
    output_batches = _output_batches(batches, content_hash)
    files = [_entry(item) for item in stored]
    files.extend(missing_videos)
    present = {item.category for item in files}
    for category in _OPTIONAL:
        if category in present:
            continue
        files.append(
            DeliveryFileEntry(
                path=f"missing/{category}",
                category=category,  # type: ignore[arg-type]
                order=0,
                missing_reason=f"Missing {category}",
            )
        )
    if not any(item.category == "final-video" for item in files):
        files.append(
            DeliveryFileEntry(
                path="missing/final-video",
                category="final-video",
                order=0,
                missing_reason="Missing final video",
            )
        )
    files.sort(key=lambda item: item.path)
    _reject_duplicate_paths(files)
    _reject_signed_urls(files)
    return DeliveryPackageManifest(
        project_id=row.project_id,
        generated_at=generated_at,
        project_content_hash=content_hash,
        play_order=play_order,
        batches=output_batches,
        files=files,
    )


def package_input_hash(manifest: DeliveryPackageManifest) -> str:
    payload = manifest.model_dump(mode="json", by_alias=True)
    payload.pop("generatedAt", None)
    return hash_content(payload)


def blocking_reason(manifest: DeliveryPackageManifest) -> str | None:
    videos = [item for item in manifest.files if item.category == "final-video"]
    confirmed = [
        item
        for item in videos
        if item.missing_reason is None and item.checksum and item.object_key
    ]
    if not confirmed or len(confirmed) != len(videos):
        return "required final-video is missing"
    if list(manifest.play_order) != [item.path for item in confirmed]:
        return "play order does not match confirmed videos"
    return None


def _entry(item: _Stored) -> DeliveryFileEntry:
    return DeliveryFileEntry(
        path=item.path,
        category=item.category,  # type: ignore[arg-type]
        order=item.order,
        object_key=item.object_key,
        checksum=item.checksum,
        size_bytes=item.size_bytes,
    )


async def _artifact_files(
    row: ProductionRow,
    artifacts: list[ArtifactRow],
    content_hash: str,
    objects: ObjectStore,
) -> list[_Stored]:
    found: list[_Stored] = []
    for artifact in artifacts:
        if artifact.status != "completed":
            continue
        if artifact.stage == "preview" and artifact.diagnostics.get("contentHash") != content_hash:
            continue
        key = _artifact_key(artifact)
        checksum = artifact.checksums[0] if artifact.checksums else None
        if not key or not checksum:
            continue
        confirmed = await objects.checksum(key)
        size = await objects.head(key)
        if confirmed != checksum or size is None:
            continue
        path = _artifact_path(artifact, checksum)
        if path is None:
            continue
        found.append(
            _Stored(path, _category(artifact.stage), 0, key, checksum, size)
        )
    ingest = (row.stage_facts.get("INGESTING") or {}).get("pages") or []
    for page in ingest:
        key = page.get("objectKey")
        checksum = page.get("checksum")
        if not isinstance(key, str) or not isinstance(checksum, str):
            continue
        if any(item.object_key == key for item in found):
            continue
        size = await objects.head(key)
        confirmed = await objects.checksum(key)
        if size is None or confirmed != checksum:
            continue
        number = int(page.get("pageNumber") or 0)
        found.append(
            _Stored(f"source/{number:04d}-{checksum[:12]}", "source", number, key, checksum, size)
        )
    return found


async def _videos(
    batches: list[BatchRow],
    content_hash: str,
    objects: ObjectStore,
) -> tuple[list[_Stored], list[DeliveryFileEntry]]:
    videos: list[_Stored] = []
    missing: list[DeliveryFileEntry] = []
    required = [batch for batch in batches if batch.required and batch.content_hash == content_hash]
    required.sort(key=lambda batch: (batch.frame_from, batch.batch_id))
    for batch in required:
        path = f"videos/{batch.frame_from:06d}-{_safe_name(batch.batch_id)}.mp4"
        confirmed = None
        size = None
        if batch.status == "completed" and batch.object_key and batch.checksum:
            confirmed = await objects.checksum(batch.object_key)
            size = await objects.head(batch.object_key)
        if confirmed == batch.checksum and size is not None and batch.object_key and batch.checksum:
            videos.append(
                _Stored(
                    path, "final-video", batch.frame_from, batch.object_key, batch.checksum, size
                )
            )
            continue
        missing.append(
            DeliveryFileEntry(
                path=path,
                category="final-video",
                order=batch.frame_from,
                missing_reason=f"Missing final video for batch {batch.batch_id}",
            )
        )
    return videos, missing


async def _put_generated(
    row: ProductionRow,
    objects: ObjectStore,
    name: str,
    path: str,
    category: str,
    body: bytes,
) -> _Stored:
    digest = hashlib.sha256(body).hexdigest()
    key = delivery_object_key(
        tenant_id=row.tenant_id,
        production_id=row.production_id,
        name=name,
        checksum=digest,
    )
    stored = await objects.put_verified(key, body, content_type="application/json")
    if stored != digest or await objects.checksum(key) != digest:
        raise ValueError("generated delivery file checksum mismatch")
    size = await objects.head(key)
    if size != len(body):
        raise ValueError("generated delivery file size mismatch")
    return _Stored(path, category, 0, key, digest, size or len(body))


def _output_batches(batches: list[BatchRow], content_hash: str) -> list[OutputBatch]:
    rows = [batch for batch in batches if batch.content_hash == content_hash]
    rows.sort(key=lambda batch: (batch.frame_from, batch.batch_id))
    output = []
    for index, batch in enumerate(rows):
        config = batch.render_config or {}
        end = int(config.get("endFrameInclusive", max(batch.frame_from, batch.frame_to - 1)))
        duration = int(config.get("durationInFrames", max(1, end - batch.frame_from + 1)))
        output.append(
            OutputBatch(
                batch_id=batch.batch_id,
                batch_index=int(config.get("batchIndex", index)),
                from_frame=batch.frame_from,
                end_frame_inclusive=end,
                duration_in_frames=duration,
                shot_ids=list(batch.shot_ids),
                reason=str(config.get("reason") or "render"),
            )
        )
    return output


def _subtitle_text(row: ProductionRow, fps: int) -> str:
    shots = (row.stage_facts.get("SYNTHESIZING_VOICE") or {}).get("shots") or []
    blocks: list[str] = []
    index = 1
    for shot in shots:
        for dialogue in shot.get("dialogues") or []:
            start = int(dialogue.get("from_frame") or dialogue.get("fromFrame") or 0)
            duration = int(
                dialogue.get("duration_in_frames") or dialogue.get("durationInFrames") or 0
            )
            text = str(dialogue.get("text") or "").strip()
            if duration <= 0 or not text:
                continue
            stamp = f"{_timestamp(start, fps)} --> {_timestamp(start + duration, fps)}"
            blocks.append(f"{index}\n{stamp}\n{text}\n")
            index += 1
    return "\n".join(blocks)


def _timestamp(frame: int, fps: int) -> str:
    millis = int(frame * 1000 / max(fps, 1))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _artifact_key(artifact: ArtifactRow) -> str | None:
    key = artifact.diagnostics.get("objectKey")
    if isinstance(key, str) and key:
        return key
    if not artifact.urls:
        return None
    path = urlparse(artifact.urls[0]).path.lstrip("/")
    return path or None


def _artifact_path(artifact: ArtifactRow, checksum: str) -> str | None:
    name = _safe_name(artifact.artifact_id)
    if artifact.stage == "ingest":
        return f"source/{name}-{checksum[:12]}"
    if artifact.stage in {"analyze", "l0-panel"}:
        return f"panels/{name}-{checksum[:12]}"
    if artifact.stage in {"layer-l1", "layer-l2", "clean-panel", "inpaint"}:
        return f"layers/{name}-{checksum[:12]}"
    if artifact.stage == "tts":
        return f"audio/{name}-{checksum[:12]}"
    if artifact.stage == "preview":
        kind = _safe_name(str(artifact.diagnostics.get("kind") or "preview"))
        return f"preview/{kind}-{checksum[:12]}"
    return None


def _category(stage: str) -> str:
    return {
        "ingest": "source",
        "analyze": "panel",
        "l0-panel": "panel",
        "layer-l1": "layer",
        "layer-l2": "layer",
        "clean-panel": "layer",
        "inpaint": "layer",
        "tts": "audio",
        "preview": "preview",
    }.get(stage, "diagnostics")


def _safe_name(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in "._:-" else "-" for character in value
    )
    return cleaned.strip(".-") or "file"


def _reject_duplicate_paths(files: list[DeliveryFileEntry]) -> None:
    seen: set[str] = set()
    for item in files:
        if item.path in seen:
            raise ValueError(f"duplicate manifest path {item.path}")
        seen.add(item.path)


def _reject_signed_urls(files: list[DeliveryFileEntry]) -> None:
    blob = " ".join(
        f"{item.path} {item.object_key or ''} {item.missing_reason or ''}" for item in files
    ).lower()
    if any(marker in blob for marker in _SIGNED):
        raise ValueError("manifest contains a signed url")
