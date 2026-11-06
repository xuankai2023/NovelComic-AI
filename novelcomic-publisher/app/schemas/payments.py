"""Payment and order schemas."""

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

PaymentResult = Literal["processing", "succeeded", "failed", "expired", "payment_failed"]


class BasePaymentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    success_url: str = Field(alias="successUrl", min_length=1)
    cancel_url: str = Field(alias="cancelUrl", min_length=1)
    request_id: str | None = Field(default=None, min_length=1, max_length=128)


class CreateCheckoutRequestParam(BasePaymentRequest):
    amount: int = Field(gt=0, description="Amount in USD.")
    payment_method: str | None = None


class CreateSubscriptionCheckoutRequestParam(BasePaymentRequest):
    subscription_key: str = Field(default="starter")
    interval: Literal["monthly", "yearly"] = "monthly"
    price_id: str = Field(min_length=1)
    payment_method: str | None = None


class UpdateSubscriptionPlanRequestParam(BasePaymentRequest):
    subscription_info_id: str
    subscription_key: str
    interval: Literal["monthly", "yearly"] = "monthly"
    price_id: str = Field(min_length=1)
    payment_method: str | None = None


class Order(BaseModel):
    order_id: str = Field(default_factory=lambda: uuid4().hex)
    checkout_request_id: str | None = None
    checkout_id: str | None = None
    checkout_url: str | None = None
    user_id: str
    type: Literal["one_time", "recurring"] = "one_time"
    amount: int = 0
    currency: str = "usd"
    stripe_order_id: str | None = None
    stripe_invoice_id: str | None = None
    pay_status: Literal["no_payment_required", "unpaid", "paid"] = "unpaid"
    pay_result: PaymentResult = "processing"
    pay_method: str | None = None
    pay_mode: Literal["payment", "subscription"] = "payment"
    fulfillment_status: Literal["pending", "processing", "completed", "failed"] = "pending"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class Payments(BaseModel):
    session_id: str | None = None
    order_id: str
    user_id: str
    customer_id: str | None = None
    amount: int = 0
    currency: str = "usd"
    payment_status: Literal["no_payment_required", "unpaid", "paid"] = "unpaid"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class CheckoutSessionResponse(BaseModel):
    id: str
    url: str
    mode: Literal["payment", "subscription"]
    status: str | None = None
    order_id: str
