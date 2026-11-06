"""Panel analysis output contract."""

from typing import Literal

from pydantic import AnyUrl, Field

from .base import ContractModel
from .ids import PageId, SpeakerId, StableLineKey


class Point(ContractModel):
    x: float
    y: float


class RawLine(ContractModel):
    stable_line_key: StableLineKey
    bubble_reading_order: int = Field(ge=0)
    text: str
    speaker_id: SpeakerId | None = None
    bubble_polygon: list[Point] | None = Field(default=None, min_length=3)
    ocr_confidence: float = Field(ge=0, le=1, allow_inf_nan=False)


class PanelBounds(ContractModel):
    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class PanelDiagnostics(ContractModel):
    panel_confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    requires_manual_review: bool
    warnings: list[str]


class PanelSpec(ContractModel):
    page_id: PageId
    panel_index: int = Field(ge=0)
    source_url: AnyUrl
    panel_url: AnyUrl
    clean_panel_url: AnyUrl | None = None
    bounds: PanelBounds
    reading_order: int = Field(ge=0)
    shot_type: Literal["environment", "close-up", "dialogue", "action"]
    dialogues: list[RawLine]
    diagnostics: PanelDiagnostics
