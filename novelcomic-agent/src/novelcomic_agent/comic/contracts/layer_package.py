"""Versioned L1 layer package. Semantics are a closed catalog, not provider text."""

from typing import Any, Literal

from pydantic import AnyUrl, Field, field_validator, model_validator

from ..canonical import hash_content
from .base import ContractModel
from .ids import ProjectId, ShotId

LAYER_SCHEMA_VERSION = 1
SEMANTIC_CATALOG_VERSION = "comic-layer-semantics-v1"

LayerSemantic = Literal[
    "background",
    "foreground",
    "body",
    "head",
    "arm-left",
    "arm-right",
    "hair",
    "eye-open",
    "eye-closed",
    "mouth-closed",
    "mouth-half",
    "mouth-open",
    "effect",
    "other",
]
MotionPolicy = Literal["static", "camera-only", "subtle", "free"]

# Stage C separates a clean plate from a person or foreground. Eye and mouth
# states belong to later sprite work and are not emitted by the L1 service.
L1_SEMANTICS = frozenset(
    {
        "background",
        "foreground",
        "body",
        "head",
        "arm-left",
        "arm-right",
        "hair",
        "effect",
        "other",
    }
)
L1_CHARACTER_SEMANTICS = frozenset(
    {"foreground", "body", "head", "arm-left", "arm-right", "hair"}
)


class LayerBounds(ContractModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)


class LayerAnchor(ContractModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class LayerCanvas(ContractModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class LayerDiagnostics(ContractModel):
    recomposition_score: float = Field(ge=0, allow_inf_nan=False)
    alpha_hole_ratio: float = Field(ge=0, allow_inf_nan=False)
    edge_artifact_score: float = Field(ge=0, allow_inf_nan=False)
    requires_fallback: bool
    warnings: list[str]


class Layer(ContractModel):
    layer_id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=64)
    name: str = Field(min_length=1, max_length=128)
    semantic: LayerSemantic
    image_url: AnyUrl
    z_index: int
    visible: bool
    bounds: LayerBounds
    anchor: LayerAnchor
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    motion_policy: MotionPolicy

    @field_validator("image_url")
    @classmethod
    def image_url_is_https(cls, value: AnyUrl) -> AnyUrl:
        if value.scheme != "https":
            raise ValueError("imageUrl must be HTTPS")
        return value


class LayerPackage(ContractModel):
    schema_version: Literal[1] = LAYER_SCHEMA_VERSION
    project_id: ProjectId
    shot_id: ShotId
    source_url: AnyUrl
    canvas: LayerCanvas
    layers: list[Layer] = Field(min_length=1)
    diagnostics: LayerDiagnostics

    @field_validator("source_url")
    @classmethod
    def source_url_is_https(cls, value: AnyUrl) -> AnyUrl:
        if value.scheme != "https":
            raise ValueError("sourceUrl must be HTTPS")
        return value

    @model_validator(mode="after")
    def layer_ids_are_unique(self) -> "LayerPackage":
        identities = [layer.layer_id for layer in self.layers]
        if len(identities) != len(set(identities)):
            raise ValueError("layerId must be unique within the shot")
        return self

    def wire(self) -> dict[str, Any]:
        """CamelCase document hashed and sent to Remotion."""

        return self.model_dump(mode="json", by_alias=True)


def layers_import_payload(package: LayerPackage) -> dict[str, Any]:
    return {"layerPackage": package.wire()}


def package_input_hash(package: LayerPackage) -> str:
    return hash_content(package.wire())
