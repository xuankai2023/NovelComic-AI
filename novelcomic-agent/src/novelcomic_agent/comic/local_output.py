"""Local preview / experiment artifacts live under novelcomic-agent/output/."""

from __future__ import annotations

from pathlib import Path

# novelcomic-agent/
_AGENT_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_ROOT = _AGENT_ROOT / "output"


def local_output_dir(*parts: str, create: bool = True) -> Path:
    """Return ``output/<parts...>``, creating it by default."""

    path = OUTPUT_ROOT.joinpath(*parts) if parts else OUTPUT_ROOT
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path
