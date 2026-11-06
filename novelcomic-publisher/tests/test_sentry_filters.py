"""Publisher Sentry 采样、脱敏，以及未捕获异常上报。"""

from __future__ import annotations

import sys
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.common.exception.handler import register_exception
from app.core.sentry import (
    before_send,
    before_send_transaction,
    init_sentry,
    traces_sampler,
)
from app.main import create_app


def test_health_checks_are_not_sampled_and_credits_are_dropped() -> None:
    class InsufficientCredits(Exception):
        pass

    assert traces_sampler({"transaction_context": {"name": "/health"}}) == 0
    assert traces_sampler({"transaction_context": {"name": "/readyz"}}) == 0
    assert traces_sampler({"transaction_context": {"name": "mq_callback"}}) == 0.05
    assert traces_sampler({"transaction_context": {"name": "GET /api/v2/flow/runs"}}) == 0.2
    assert before_send_transaction({"transaction": "/health"}, {}) is None
    assert before_send_transaction({"transaction": "/readyz"}, {}) is None
    assert (
        before_send(
            {"extra": {"prompt": "secret"}},
            {"exc_info": (InsufficientCredits, InsufficientCredits(), None)},
        )
        is None
    )
    sent = before_send(
        {
            "extra": {
                "prompt": "draw this",
                "token": "secret-token",
                "authorization": "Bearer secret",
                "flow_id": "flow-1",
            }
        },
        {},
    )
    assert sent is not None
    assert sent["extra"]["prompt"] == "[FILTERED]"
    assert sent["extra"]["token"] == "[FILTERED]"
    assert sent["extra"]["authorization"] == "[FILTERED]"
    assert sent["extra"]["flow_id"] == "flow-1"


def test_empty_dsn_skips_init_and_a_dsn_keeps_the_sampler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called: list[dict[str, Any]] = []

    class Sdk:
        @staticmethod
        def init(**kwargs: Any) -> None:
            called.append(kwargs)

    monkeypatch.setitem(sys.modules, "sentry_sdk", Sdk)
    init_sentry("", "local")
    assert called == []
    init_sentry("https://dsn.example/1", "test")
    assert called[0]["dsn"] == "https://dsn.example/1"
    assert called[0]["traces_sampler"] is traces_sampler
    assert called[0]["before_send"] is before_send
    assert called[0]["profiles_sample_rate"] == 0.1
    assert called[0]["send_default_pii"] is False


def test_unhandled_exception_is_captured_and_http_errors_are_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[BaseException] = []

    class Sdk:
        @staticmethod
        def capture_exception(exc: BaseException) -> None:
            captured.append(exc)

    monkeypatch.setitem(sys.modules, "sentry_sdk", Sdk)
    app = FastAPI()
    register_exception(app)

    @app.get("/boom-for-sentry")
    async def boom() -> None:
        raise RuntimeError("boom")

    @app.get("/missing-for-sentry")
    async def missing() -> None:
        raise HTTPException(status_code=404, detail="missing")

    @app.get("/business-for-sentry")
    async def business() -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": 1007, "msg": "Access token not found", "data": None},
        )

    with TestClient(app, raise_server_exceptions=False) as client:
        failed = client.get("/boom-for-sentry")
        absent = client.get("/missing-for-sentry")
        business_response = client.get("/business-for-sentry")

    with TestClient(create_app()) as publisher:
        health = publisher.get("/health")

    assert failed.status_code == 500
    assert failed.json()["msg"] == "Internal server error"
    assert len(captured) == 1
    assert isinstance(captured[0], RuntimeError)
    assert absent.status_code == 404
    assert business_response.status_code == 500
    assert business_response.json()["code"] == 1007
    assert health.status_code == 200
    assert len(captured) == 1
