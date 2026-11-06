"""Redis keys used by the unified credits runtime."""

CREDIT_BALANCE_CHECK_KEY = "opencreator:credit_balance_check:{user_id}"
SUBSCRIPTION_USER_CREDITS_KEY = "opencreator:subscription_user_credits:{user_id}"
GIFT_CREDITS_KEY = "opencreator:gift_credits:{user_id}"
CREDITS_IDEMPOTENCY_KEY = "opencreator:credits:idempotency:{idempotency_key}"


def credit_balance_check_key(user_id: str) -> str:
    return CREDIT_BALANCE_CHECK_KEY.format(user_id=user_id)


def subscription_user_credits_key(user_id: str) -> str:
    return SUBSCRIPTION_USER_CREDITS_KEY.format(user_id=user_id)


def gift_credits_key(user_id: str) -> str:
    return GIFT_CREDITS_KEY.format(user_id=user_id)


def credits_idempotency_key(idempotency_key: str) -> str:
    return CREDITS_IDEMPOTENCY_KEY.format(idempotency_key=idempotency_key)
