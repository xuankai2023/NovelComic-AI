"""Stream one object at a time into a fixed-layout ZIP."""

from __future__ import annotations

import tempfile
import zipfile
from collections.abc import Iterable

from ..contracts.errors import ComicServiceError

_ROOT_FILES = frozenset({"manifest.json", "play-order.json"})
_PREFIXES = (
    "source/",
    "panels/",
    "layers/",
    "audio/",
    "subtitles/",
    "preview/",
    "videos/",
    "project/",
    "diagnostics/",
)
_REQUIRED = frozenset({"manifest.json", "play-order.json", "project/project.json"})


class PackageBuilder:
    def __init__(
        self,
        *,
        max_file_bytes: int = 512 * 1024 * 1024,
        max_total_bytes: int = 2 * 1024 * 1024 * 1024,
    ) -> None:
        self._max_file_bytes = max_file_bytes
        self._max_total_bytes = max_total_bytes

    def build(self, entries: Iterable[tuple[str, bytes]]) -> bytes:
        spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        seen: set[str] = set()
        total = 0
        ordered = sorted(entries, key=lambda item: item[0])
        with zipfile.ZipFile(spool, "w") as archive:
            for path, body in ordered:
                arcname = safe_zip_path(path)
                if arcname in seen:
                    raise ComicServiceError(
                        "COMPOSE_FAILED",
                        "zip path is duplicated",
                        retryable=False,
                        details={"path": arcname},
                    )
                if len(body) > self._max_file_bytes or total + len(body) > self._max_total_bytes:
                    raise ComicServiceError(
                        "COMPOSE_FAILED",
                        "zip entry exceeds the size limit",
                        retryable=False,
                        details={"path": arcname},
                    )
                seen.add(arcname)
                total += len(body)
                info = zipfile.ZipInfo(arcname, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 0
                info.external_attr = 0o644 << 16
                archive.writestr(info, body, compresslevel=9)
        missing = _REQUIRED - seen
        if missing:
            raise ComicServiceError(
                "COMPOSE_FAILED",
                "zip is missing a required delivery file",
                retryable=False,
                details={"paths": sorted(missing)},
            )
        spool.seek(0)
        return spool.read()


def safe_zip_path(path: str) -> str:
    if not path or path.startswith(("/", "\\")) or "\\" in path or ".." in path.split("/"):
        raise ComicServiceError(
            "COMPOSE_FAILED",
            "zip path is unsafe",
            retryable=False,
            details={"path": path},
        )
    if path in _ROOT_FILES or path.startswith(_PREFIXES):
        return path
    raise ComicServiceError(
        "COMPOSE_FAILED",
        "zip path is outside the delivery layout",
        retryable=False,
        details={"path": path},
    )
