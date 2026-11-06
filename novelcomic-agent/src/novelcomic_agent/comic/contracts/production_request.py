"""Product request accepted by the comic production control plane."""

from decimal import Decimal
from typing import Literal

from pydantic import AnyUrl, Field, field_validator

from .base import ContractModel


class SourcePage(ContractModel):
    client_source_id: str | None = Field(default=None, min_length=1, max_length=256)
    image_url: AnyUrl
    page_number: int = Field(gt=0)

    @field_validator("image_url")
    @classmethod
    def require_https(cls, value: AnyUrl) -> AnyUrl:
        if value.scheme != "https":
            raise ValueError("source page URL must use HTTPS")
        return value


class OutputSpec(ContractModel):
    width: Literal[1080]
    height: Literal[1920]
    fps: Literal[30]
    language: str = Field(min_length=1)
    panel_fit_policy: Literal["blurred-background-contain"]


class StyleSpec(ContractModel):
    motion_strength: Literal["subtle", "normal"]
    subtitle_mode: Literal["clean-bubble-and-caption", "preserve-bubble"]


class BudgetSpec(ContractModel):
    project_limit_rmb: Decimal = Field(ge=0, allow_inf_nan=False)
    shot_limit_rmb: Decimal = Field(ge=0, allow_inf_nan=False)
    max_paid_calls_per_shot: int = Field(ge=0)


class ProductionRequest(ContractModel):
    prod_client_request_id: str = Field(min_length=1, max_length=256)
    contract_version: Literal[1]
    source_pages: list[SourcePage] = Field(min_length=1)
    reading_direction: Literal["rtl", "ltr"]
    output: OutputSpec
    style: StyleSpec
    budget: BudgetSpec
    voices: dict[str, str] | None = None
    default_voice_id: str = Field(min_length=1)
