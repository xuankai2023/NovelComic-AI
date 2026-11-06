"""Internal model dropdown order request schemas."""

from pydantic import BaseModel, Field, field_validator

from app.schemas.model_dropdown_order import DROPDOWN_GROUP_NAMES


class UpsertBrandOrderRequest(BaseModel):
    image: list[str] = Field(min_length=1)
    video: list[str] = Field(min_length=1)


class ModelSortItemRequest(BaseModel):
    config_name: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    brand: str | None = None
    released_at: str | None = None
    sort_in_brand: int | None = None
    dropdown_groups: list[str] | None = None

    @field_validator("released_at")
    @classmethod
    def validate_released_at(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return value
        parts = value.split("-")
        if len(parts) != 3:
            raise ValueError("released_at must be YYYY-MM-DD")
        year, month, day = parts
        if not (
            len(year) == 4
            and len(month) == 2
            and len(day) == 2
            and year.isdigit()
            and month.isdigit()
            and day.isdigit()
        ):
            raise ValueError("released_at must be YYYY-MM-DD")
        month_n = int(month)
        day_n = int(day)
        if month_n < 1 or month_n > 12 or day_n < 1 or day_n > 31:
            raise ValueError("released_at date is invalid")
        return value

    @field_validator("dropdown_groups")
    @classmethod
    def validate_dropdown_groups(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        unknown = [item for item in value if item not in DROPDOWN_GROUP_NAMES]
        if unknown:
            raise ValueError(f"unknown dropdown_groups: {unknown}")
        return value


class BatchUpdateModelSortRequest(BaseModel):
    items: list[ModelSortItemRequest] = Field(min_length=1)
