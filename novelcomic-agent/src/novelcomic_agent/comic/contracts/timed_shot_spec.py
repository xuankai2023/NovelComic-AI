"""Final shot timeline contract frozen after audio synthesis."""

from typing import Literal

from pydantic import AnyUrl, Field, model_validator

from .base import ContractModel
from .ids import LineId, PageId, ShotId, SpeakerId, StableLineKey
from .line_audio import VisemeValue
from .panel_spec import Point

AnimationLevel = Literal["L0", "L1", "L2", "L3"]


class FrameViseme(ContractModel):
    frame: int = Field(ge=0)
    value: VisemeValue


class TimedDialogueSpec(ContractModel):
    line_id: LineId
    stable_line_key: StableLineKey
    text: str
    speaker_id: SpeakerId | None = None
    bubble_polygon: list[Point] | None = Field(default=None, min_length=3)
    from_frame: int = Field(ge=0)
    duration_in_frames: int = Field(gt=0)
    voice_url: AnyUrl | None = None
    visemes: list[FrameViseme] | None = None


class TimedShotSpec(ContractModel):
    shot_id: ShotId
    page_id: PageId
    panel_index: int = Field(ge=0)
    panel_part_index: int = Field(ge=0)
    panel_url: AnyUrl
    animation_level: AnimationLevel
    duration_in_frames: int = Field(gt=0)
    camera_preset_id: Literal["camera-push", "camera-pull", "pan-left", "pan-right"]
    seed: int
    dialogues: list[TimedDialogueSpec]

    @model_validator(mode="after")
    def dialogues_stay_in_shot(self) -> "TimedShotSpec":
        for dialogue in self.dialogues:
            if dialogue.from_frame + dialogue.duration_in_frames > self.duration_in_frames:
                raise ValueError("dialogue must stay within shot bounds")
        return self
