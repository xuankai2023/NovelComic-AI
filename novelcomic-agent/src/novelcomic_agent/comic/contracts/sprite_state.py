"""Stage D eye/mouth state assets. IDs are derived, never taken from a provider."""

from typing import Any, Literal

from pydantic import AnyUrl, Field, field_validator, model_validator

from ..canonical import hash_content
from .base import ContractModel
from .ids import ProjectId, ShotId
from .layer_package import LayerAnchor, LayerBounds, LayerCanvas

SPRITE_SCHEMA_VERSION = 1
SPRITE_CATALOG_VERSION = "comic-sprite-semantics-v1"
EYE_SEMANTICS = frozenset({"open", "closed"})
MOUTH_SEMANTICS = frozenset({"closed", "open", "half"})
MOUTH_REQUIRED = frozenset({"closed", "open"})
SpritePart = Literal["eye", "mouth"]
SpriteSemantic = Literal["open", "closed", "half"]


def eye_item_id(shot_id: str) -> str:
    return f"item:{shot_id}:eye"


def mouth_item_id(shot_id: str) -> str:
    return f"item:{shot_id}:mouth"


def sprite_asset_id(shot_id: str, part: str, semantic: str) -> str:
    """asset:{shotId}:eye:open — the same id Remotion stores for an eye-open layer."""

    return f"asset:{shot_id}:{part}:{semantic}"


def dialogue_item_id(shot_id: str, line_id: str) -> str:
    return f"dialogue:{shot_id}:{line_id}"


def state_key(part: str, semantic: str) -> str:
    return f"{part}:{semantic}"


def remotion_layer_semantic(part: str, semantic: str) -> str:
    return f"{part}-{semantic}"


def required_state_keys(*, dialogue_present: bool) -> tuple[str, ...]:
    keys = ["eye:open", "eye:closed"]
    if dialogue_present:
        keys.extend(["mouth:closed", "mouth:open"])
    return tuple(keys)


class SpriteStateAsset(ContractModel):
    shot_id: ShotId
    part: SpritePart
    semantic: SpriteSemantic
    asset_id: str = Field(min_length=1)
    image_url: AnyUrl
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    bounds: LayerBounds
    anchor: LayerAnchor
    checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    model_version: str = Field(min_length=1)
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    color_type: int | None = Field(default=None, ge=0, le=6)

    @field_validator("image_url")
    @classmethod
    def image_url_is_https(cls, value: AnyUrl) -> AnyUrl:
        if value.scheme != "https":
            raise ValueError("imageUrl must be HTTPS")
        return value

    @model_validator(mode="after")
    def asset_id_matches_the_stable_rule(self) -> "SpriteStateAsset":
        expected = sprite_asset_id(self.shot_id, self.part, self.semantic)
        if self.asset_id != expected:
            raise ValueError("assetId must be derived from the shot, part, and semantic")
        if self.part == "eye" and self.semantic not in EYE_SEMANTICS:
            raise ValueError("eye states are open or closed")
        return self


class SpriteAssetSet(ContractModel):
    """Uploaded state images. This document does not contain spriteStates."""

    schema_version: Literal[1] = SPRITE_SCHEMA_VERSION
    project_id: ProjectId
    shot_id: ShotId
    canvas: LayerCanvas
    reference_layer_id: str = Field(min_length=1)
    states: list[SpriteStateAsset]
    missing: list[str]
    partial: bool
    dialogue_present: bool
    warnings: list[str]

    @model_validator(mode="after")
    def states_belong_to_the_shot(self) -> "SpriteAssetSet":
        if not self.states:
            return self
        shared_hash = self.states[0].input_hash
        for state in self.states:
            if state.shot_id != self.shot_id:
                raise ValueError("sprite state shotId must match the set")
            if state.input_hash != shared_hash:
                raise ValueError("sprite states must share one inputHash")
        return self

    def wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True)


def sprite_set_hash(asset_set: SpriteAssetSet) -> str:
    return hash_content(asset_set.wire())
