"""Legacy chat stays a short 410, and a run does not pick up dynamic MCP tools."""

from __future__ import annotations

import inspect
import time
from dataclasses import fields

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

import novelcomic_agent.agents.main.profile as main_profile
from novelcomic_agent.agents.main.profile import AgentContext, AgentFactory
from novelcomic_agent.api.server import create_agent_router
from novelcomic_agent.config import Settings
from novelcomic_agent.core.loop import AgentLoop
from novelcomic_agent.core.memory import connect_memory
from novelcomic_agent.core.memory.mem0_memory import Mem0Memory
from novelcomic_agent.workflow.event_bridge import (
    RunSnapshot,
    clear_run_snapshots,
    store_run_snapshot,
)
from novelcomic_agent.workflow.generation_confirm import (
    PendingGeneration,
    clear_pending_generations,
    store_pending_generation,
)

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def _token(sub: str) -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(
        create_agent_router(
            Settings(
                clerk_pem_public_key=_PUBLIC_PEM,
                memory_enabled=False,
                public_chat_user_id="",
            )
        )
    )
    return TestClient(app)


def test_legacy_chat_and_stop_return_use_agent_runs() -> None:
    client = _client()
    chat = client.post("/v1/agent/chat")
    stop = client.post("/api/v1/agent/chat/stop")

    assert chat.status_code == 410
    assert chat.json()["code"] == "USE_AGENT_RUNS"
    assert stop.status_code == 410
    assert stop.json()["code"] == "USE_AGENT_RUNS"
    assert "/v1/agent/runs/{run_id}/cancel" in stop.json()["message"]


def test_connect_mcp_returns_before_registering_tools() -> None:
    source = inspect.getsource(AgentLoop._connect_mcp)
    body = source.split(":\n", 1)[1]
    first = next(line.strip() for line in body.splitlines() if line.strip())
    assert first.startswith("return")

    built = AgentFactory().build(AgentContext())
    assert all(not name.startswith("mcp_") for name in built.tools.tool_names)
    assert "continue_workflow" not in built.tools.tool_names


def test_main_profile_keeps_continue_workflow_commented_out() -> None:
    source = inspect.getsource(main_profile)
    assert "# def _continue_workflow" in source
    assert "ContinueWorkflowTool" in source
    built = AgentFactory().build(AgentContext())
    assert "continue_workflow" not in built.tools.tool_names


def test_memory_connects_only_when_enabled() -> None:
    disabled = connect_memory(Settings(memory_enabled=False))
    enabled = connect_memory(Settings(memory_enabled=True))
    assert disabled is None
    assert isinstance(enabled, Mem0Memory)


def test_select_reads_snapshot_without_user_id_and_confirm_checks_owner() -> None:
    assert "user_id" not in {item.name for item in fields(RunSnapshot)}
    clear_run_snapshots()
    clear_pending_generations()
    store_run_snapshot(
        RunSnapshot(flow_task_id="task-1", ws_id="ws-1", nodes=[{"id": "n"}], edges=[])
    )
    store_pending_generation(PendingGeneration(confirm_id="card-1", user_id="user-a"))
    client = _client()
    headers = {"Authorization": f"Bearer {_token('user-b')}"}

    selected = client.post(
        "/v1/agent/workflow/select",
        headers=headers,
        json={"flow_task_id": "task-1"},
    )
    forbidden = client.post(
        "/v1/agent/generation/confirm",
        headers=headers,
        json={"confirm_id": "card-1"},
    )
    allowed = client.post(
        "/v1/agent/generation/confirm",
        headers={"Authorization": f"Bearer {_token('user-a')}"},
        json={"confirm_id": "card-1"},
    )

    assert selected.status_code == 200
    assert selected.json()["flow_task_id"] == "task-1"
    assert "user_id" not in selected.json()
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"]["code"] == "CONFIRM_FORBIDDEN"
    assert allowed.status_code == 200
    assert allowed.json()["status"] == "confirmed"


@pytest.fixture(autouse=True)
def _clear_workflow_state() -> None:
    clear_run_snapshots()
    clear_pending_generations()
    yield
    clear_run_snapshots()
    clear_pending_generations()
