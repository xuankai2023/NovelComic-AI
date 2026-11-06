"""Share creation and visit request shapes."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

ShareType = Literal["workflow", "app_only", "app_and_workflow", "collaborative"]


class CreateShareRequest(BaseModel):
    flow_id: str = Field(min_length=1, max_length=255)
    email_whitelist: list[str] = Field(default_factory=list, max_length=100)
    allow_reshare: bool = True
    share_type: ShareType = "workflow"

    @field_validator("email_whitelist")
    @classmethod
    def normalize_email_whitelist(cls, value: list[str] | None) -> list[str]:
        if not value:
            return []
        emails: list[str] = []
        seen: set[str] = set()
        for item in value:
            email = item.strip().lower()
            if not email or email in seen:
                continue
            emails.append(email)
            seen.add(email)
        return emails


class VisitShareRequest(BaseModel):
    share_id: str = Field(min_length=1, max_length=255)
