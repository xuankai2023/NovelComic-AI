"""Subscription records written when a paid invoice is fulfilled."""

from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

SubscriptionInterval = Literal["monthly", "yearly"]
SubscriptionRecordType = Literal["recurring", "one_time"]


class SubscriptionMetadata(BaseModel):
    user_id: str
    subscription_key: str = ""
    interval: SubscriptionInterval = "monthly"
    subscription_credits: int = 0
    level: int = 0


class SubscriptionInfo(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    user_id: str
    stripe_subscription_id: str | None = None
    stripe_order_id: str | None = None
    order_id: str | None = None
    status: str = "active"
    subscription_type: SubscriptionRecordType = "recurring"
    price_ids: list[str] = Field(default_factory=list)
    currency: str = "usd"
    start_timestamp: int = 0
    end_timestamp: int = 0
    last_paid_invoice_id: str | None = None
    subscription_metadata: SubscriptionMetadata | None = None
