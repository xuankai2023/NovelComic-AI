"""Per-line synthesized audio contract."""

from typing import Literal

from pydantic import AnyUrl, Field, model_validator

from .base import ContractModel
from .ids import StableLineKey

VisemeValue = Literal["closed", "half", "open"]


class TimedViseme(ContractModel):
    time_ms: int = Field(ge=0)
    value: VisemeValue


class LineAudio(ContractModel):
    stable_line_key: StableLineKey
    audio_url: AnyUrl | None = None
    duration_ms: int | None = Field(default=None, gt=0)
    provider_request_id: str | None = Field(default=None, min_length=1)
    visemes: list[TimedViseme] | None = None
    missing_reason: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_audio_or_reason(self) -> "LineAudio":
        if self.audio_url is None and self.missing_reason is None:
            raise ValueError("audio_url or missing_reason is required")
        if self.audio_url is not None and self.duration_ms is None:
            raise ValueError("duration_ms is required when audio_url is present")
        return self
