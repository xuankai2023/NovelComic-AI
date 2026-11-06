"""Invite code, reward and summary schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

InviteRewardType = Literal["register", "paid"]


def normalize_invite_code(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().upper()
    return normalized or None


class InviteRelation(BaseModel):
    invite_code: str
    inviter_user_id: str
    invitee_user_id: str
    invitee_email: str | None = None
    created_at: datetime
    registration_rewarded: bool = False
    paid_rewarded: bool = False
    paid_at: datetime | None = None

    @field_validator("invite_code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        normalized = normalize_invite_code(value)
        if not normalized:
            raise ValueError("invite_code is required")
        return normalized


class InviteCreditRecord(BaseModel):
    inviter_user_id: str
    invitee_user_id: str
    reward_type: InviteRewardType
    points: int = Field(ge=1)
    source_id: str
    created_at: datetime


class InviteSummary(BaseModel):
    invite_code: str
    invite_link_path: str = ""
    invited_count: int = 0
    register_points: int = 0
    paid_points: int = 0
    total_points: int = 0


class InviteRelationPage(BaseModel):
    items: list[InviteRelation]
    total: int
    page: int
    page_size: int


class InviteCreditRecordPage(BaseModel):
    items: list[InviteCreditRecord]
    total: int
    page: int
    page_size: int
