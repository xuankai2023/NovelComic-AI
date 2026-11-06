"""Unified credits data shapes."""

from datetime import UTC, datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class SubscriptionCredits(BaseModel):
    user_id: str
    credits_balance: int = 0
    status: str = "active"
    subscription_info_id: str | None = None
    stripe_subscription_id: str | None = None

    @property
    def active_balance(self) -> int:
        return self.credits_balance if self.status == "active" else 0


class GiftCredits(BaseModel):
    user_id: str
    amount: int = 0
    expires_at: datetime | None = None
    source: str | None = None

    def is_active(self, now: datetime | None = None) -> bool:
        current = now or datetime.now(UTC)
        return self.expires_at is None or self.expires_at > current


class UserCreditsSnapshot(BaseModel):
    """Mongo-backed view of the three credit buckets."""

    user_id: str
    topup_credits: Decimal = Field(default=Decimal(0))
    subscription_credits: SubscriptionCredits | None = None
    gift_credits: GiftCredits | None = None

    @property
    def subscription_credits_balance(self) -> Decimal:
        if self.subscription_credits is None:
            return Decimal(0)
        return Decimal(self.subscription_credits.active_balance)

    @property
    def gift_credits_balance(self) -> Decimal:
        if self.gift_credits is None or not self.gift_credits.is_active():
            return Decimal(0)
        return Decimal(self.gift_credits.amount)

    @property
    def total_credits(self) -> Decimal:
        return self.topup_credits + self.subscription_credits_balance + self.gift_credits_balance

    @property
    def topup_credits_display(self) -> str:
        return str(round(self.topup_credits))

    @property
    def total_credits_display(self) -> str:
        return str(round(self.total_credits))
