from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelcomic_agent.api.server import create_agent_router
from novelcomic_agent.config import Settings, public_switch_dump
from novelcomic_agent.legacy import legacy_call_volume, reset_legacy_call_volume


def test_legacy_chat_counts_both_410_routes() -> None:
    reset_legacy_call_volume()
    app = FastAPI()
    app.include_router(create_agent_router(Settings(memory_enabled=False)))
    client = TestClient(app)
    chat = client.post("/v1/agent/chat")
    stop = client.post("/api/v1/agent/chat/stop")

    assert chat.status_code == 410
    assert stop.status_code == 410
    assert legacy_call_volume()["legacy_agent_chat"] == 2


def test_public_switch_dump_keeps_secrets_out() -> None:
    dumped = public_switch_dump(
        Settings(
            memory_enabled=True,
            posthog_enabled=False,
            posthog_api_key="ph_live",
            sentry_dsn="dsn-value",
        )
    )
    assert dumped == {"memory_enabled": True, "posthog_enabled": False}
    assert "ph_live" not in repr(dumped)
    assert "dsn-value" not in repr(dumped)
