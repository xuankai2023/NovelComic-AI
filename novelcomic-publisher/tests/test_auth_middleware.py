import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Request
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import get_settings
from app.dependencies.authenticated_user import get_authenticated_user
from app.main import create_app
from app.services.auth_service import RateLimitError
from app.services.jwt import JwtExpiredTokenError, JwtInvalidTokenError, JwtService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


@pytest.fixture(autouse=True)
def clerk_public_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "clerk_pem_public_key", _PUBLIC_PEM)


def _token(sub: str, exp: int) -> str:
    encoded = jwt.encode({"sub": sub, "exp": exp}, _PRIVATE_KEY, algorithm="RS256")
    return encoded if isinstance(encoded, str) else encoded.decode()


def test_get_user_id_returns_sub() -> None:
    token = _token("user_abc", int(time.time()) + 60)
    assert asyncio.run(JwtService.get_user_id_with_backoff(token)) == "user_abc"


def test_get_user_id_rejects_expired_and_bad_tokens() -> None:
    expired = _token("user_abc", int(time.time()) - 10)
    with pytest.raises(JwtExpiredTokenError):
        asyncio.run(JwtService.get_user_id_with_backoff(expired))

    with pytest.raises(JwtInvalidTokenError):
        asyncio.run(JwtService.get_user_id_with_backoff("not-a-jwt"))


def test_whitelist_login_routes_pass_without_authorization() -> None:

    with patch(
        "app.controller.v2.auth.AuthService.send_verification_code",
        new=AsyncMock(side_effect=RateLimitError("发送过于频繁,请 1 秒后再试")),
    ):
        response = TestClient(create_app()).post(
            "/api/v2/auth/send-code",
            json={"email": "user@example.com", "fp_hash": "abc", "fp_time": "Asia/Shanghai"},
        )
    assert response.status_code == 429

    missing = TestClient(create_app()).post("/api/v2/auth/change-password", json={})
    assert missing.status_code == 401
    assert missing.json()["code"] == 1002


def test_protected_route_rejects_missing_wrong_and_expired_tokens() -> None:
    client = TestClient(create_app())
    missing = client.get("/api/v2/user/info")
    assert missing.status_code == 401
    assert missing.json()["msg"] == "Authorization field is required"

    wrong = client.get("/api/v2/user/info", headers={"Authorization": "Bearer not-a-jwt"})
    assert wrong.status_code == 401
    assert wrong.json()["msg"] == "Invalid token"

    expired = _token("user_abc", int(time.time()) - 10)
    old = client.get("/api/v2/user/info", headers={"Authorization": f"Bearer {expired}"})
    assert old.status_code == 401
    assert old.json()["msg"] == "Token has expired"


def test_auth_error_response_keeps_cors_headers() -> None:
    response = TestClient(create_app()).get(
        "/api/v2/user/info",
        headers={
            "Authorization": "Bearer not-a-jwt",
            "Origin": "http://localhost:3000",
        },
    )

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert response.json()["msg"] == "Invalid token"


def test_valid_jwt_sets_request_user_id_to_sub() -> None:
    app = create_app()

    @app.get("/api/v2/whoami")
    def whoami(request: Request) -> dict[str, str]:
        user = get_authenticated_user(request)
        return {"user_id": user.user_id}

    token = _token("user_abc", int(time.time()) + 60)
    response = TestClient(app).get(
        "/api/v2/whoami",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["user_id"] == "user_abc"


def test_v1_flow_task_fails_jwt_instead_of_public_user() -> None:
    client = TestClient(create_app())
    missing = client.get("/api/v1/flow/flow_task/ws-1")
    assert missing.status_code == 401
    assert missing.json()["code"] == 1002
    assert missing.json()["msg"] == "Authorization field is required"

    with pytest.raises(WebSocketDisconnect) as caught:
        with client.websocket_connect("/api/v1/flow/flow_task/ws-1"):
            pass
    assert caught.value.code == 1000


def test_v1_flow_task_websocket_with_jwt_sets_sub() -> None:
    from starlette.requests import HTTPConnection

    from app.middleware.auth_middleware import PUBLIC_USER, ClerkAuthenticationBackend

    token = _token("user_abc", int(time.time()) + 60)
    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "scheme": "ws",
        "method": "GET",
        "path": "/api/v1/flow/flow_task/ws-1",
        "raw_path": b"/api/v1/flow/flow_task/ws-1",
        "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "client": ("127.0.0.1", 123),
        "server": ("testserver", 80),
        "subprotocols": [],
    }
    backend = ClerkAuthenticationBackend()
    credentials, user = asyncio.run(backend.authenticate(HTTPConnection(scope)))
    assert user is not PUBLIC_USER
    assert user.user_id == "user_abc"
    assert "authenticated" in credentials.scopes


def test_websocket_upgrade_is_accepted_without_authorization() -> None:
    app = create_app()
    app.state.connections = SimpleNamespace(
        mongo={"novelcomic": SimpleNamespace()},
        redis=SimpleNamespace(),
    )
    client = TestClient(app)

    with client.websocket_connect("/api/v2/flow/runs/task-1/events/conn-1") as websocket:
        websocket.send_json({"event_type": "ping", "protocol_version": 2})
        message = websocket.receive_json()
        assert message["code"] == "AUTH_REQUIRED"
        with pytest.raises(WebSocketDisconnect) as caught:
            websocket.receive_json()

    assert caught.value.code == 4401
