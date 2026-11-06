from novelcomic_agent.posthog import capture_event, capture_generation, init_posthog
from novelcomic_agent.sentry import SafeSpan, before_send_transaction, init_sentry, traces_sampler


def test_empty_sentry_dsn_skips_initialization() -> None:
    init_sentry("")
    init_sentry("", "test")


def test_health_transactions_are_not_sampled() -> None:
    assert traces_sampler({"transaction_context": {"name": "/health"}}) == 0
    assert traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0
    assert traces_sampler({"transaction_context": {"name": "/v1/agent/runs"}}) == 1.0
    assert before_send_transaction({"transaction": "/health"}, {}) is None
    assert before_send_transaction({"transaction": "/readyz"}, {}) is None
    assert before_send_transaction({"transaction": "/v1/agent/runs"}, {}) == {
        "transaction": "/v1/agent/runs"
    }


def test_safe_span_swallows_sdk_errors(monkeypatch) -> None:
    real_import = __import__

    def broken_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "sentry_sdk":
            raise RuntimeError("sentry sdk failed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", broken_import)
    with SafeSpan("gen_ai.request", "chat") as span:
        span.set_data("gen_ai.request.model", "model")
        span.set_status("ok")


def test_posthog_capture_is_a_noop_without_key_or_flag() -> None:
    init_posthog(api_key="", enabled=True)
    init_posthog(api_key="ph_test", enabled=False)
    capture_event("agent.run.started", {"run_id": "run-1"})
    capture_generation(model="agent-model", provider="test")
