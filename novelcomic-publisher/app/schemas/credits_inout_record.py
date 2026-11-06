"""Credits ledger schemas."""

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

CreditsInoutDirection = Literal["in", "out"]
CreditsInoutCreditType = Literal["topup", "subscription", "gift", "usage"]
CreditsInoutEventType = Literal[
    "recharge",
    "admin_topup",
    "admin_deduct",
    "feishu_topup",
    "invite_reward",
    "official_gift",
    "gift_expire",
    "subscription_grant",
    "subscription_monthly_renew",
    "subscription_expire",
    "usage_deduct",
]


class CreditsInoutRecord(BaseModel):
    """Full in/out ledger row for credits reconciliation."""

    credits_inout_record_id: str = Field(default_factory=lambda: uuid4().hex)
    user_id: str
    user_email: str | None = None
    credit_type: CreditsInoutCreditType
    event_type: CreditsInoutEventType
    direction: CreditsInoutDirection
    amount: int = Field(ge=0)
    signed_amount: int
    balance_before: int
    balance_after: int
    reason: str | None = None
    source: str | None = None
    source_table: str | None = None
    source_id: str | None = None
    idempotency_key: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
