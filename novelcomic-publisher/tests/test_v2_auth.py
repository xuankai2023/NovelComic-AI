from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.auth_service import (
    EmailSendError,
    InvalidCodeError,
    InvalidPasswordError,
    RateLimitError,
    UserNotFoundError,
)


def client() -> TestClient:
    return TestClient(create_app())


def test_send_code_returns_code_type() -> None:
    payload = {"email": "user@example.com", "code_type": "login", "expires_in": 300}
    with patch(
        "app.controller.v2.auth.AuthService.send_verification_code",
        new=AsyncMock(return_value=payload),
    ) as send:
        response = client().post(
            "/api/v2/auth/send-code",
            json={"email": "User@Example.com", "fp_hash": "abc", "fp_time": "Asia/Shanghai"},
        )
    assert response.status_code == 200
    assert response.json() == {"code": 200, "msg": "验证码已发送", "data": payload}
    send.assert_awaited_once_with(
        email="user@example.com",
        fp_hash="abc",
        fp_time="Asia/Shanghai",
    )


def test_send_code_rate_limit() -> None:
    with patch(
        "app.controller.v2.auth.AuthService.send_verification_code",
        new=AsyncMock(side_effect=RateLimitError("发送过于频繁,请 60 秒后再试")),
    ):
        response = client().post(
            "/api/v2/auth/send-code",
            json={"email": "user@example.com", "fp_hash": "abc", "fp_time": "Asia/Shanghai"},
        )
    assert response.status_code == 429
    assert response.json()["code"] == 1005
    assert "60" in response.json()["msg"]


def test_send_code_email_failure() -> None:
    with patch(
        "app.controller.v2.auth.AuthService.send_verification_code",
        new=AsyncMock(side_effect=EmailSendError("down")),
    ):
        response = client().post(
            "/api/v2/auth/send-code",
            json={"email": "user@example.com", "fp_hash": "abc", "fp_time": "Asia/Shanghai"},
        )
    assert response.status_code == 500
    assert response.json()["msg"] == "邮件发送失败,请稍后重试"


def test_login_with_code_returns_ticket() -> None:
    payload = {"ticket": "ticket-1", "user_id": "user_1"}
    with patch(
        "app.controller.v2.auth.AuthService.verify_code_and_login",
        new=AsyncMock(return_value=payload),
    ) as login:
        response = client().post(
            "/api/v2/auth/login-with-code",
            json={"email": "user@example.com", "code": "123456"},
        )
    assert response.status_code == 200
    assert response.json()["data"] == payload
    login.assert_awaited_once_with("user@example.com", "123456")


def test_login_with_code_invalid_and_missing_user() -> None:
    with patch(
        "app.controller.v2.auth.AuthService.verify_code_and_login",
        new=AsyncMock(side_effect=InvalidCodeError("验证码错误")),
    ):
        bad_code = client().post(
            "/api/v2/auth/login-with-code",
            json={"email": "user@example.com", "code": "123456"},
        )
    assert bad_code.status_code == 400
    assert bad_code.json()["msg"] == "验证码错误"

    with patch(
        "app.controller.v2.auth.AuthService.verify_code_and_login",
        new=AsyncMock(side_effect=UserNotFoundError("该邮箱尚未注册")),
    ):
        missing = client().post(
            "/api/v2/auth/login-with-code",
            json={"email": "user@example.com", "code": "123456"},
        )
    assert missing.status_code == 404
    assert missing.json()["code"] == 1010


def test_register_uses_forwarded_ip_and_returns_sign_in_token() -> None:
    payload = {"sign_in_token": "tok", "expires_in": 2592000, "user_id": "user_1"}
    with patch(
        "app.controller.v2.auth.AuthService.register_with_code",
        new=AsyncMock(return_value=payload),
    ) as register:
        response = client().post(
            "/api/v2/auth/register-with-code",
            headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"},
            json={
                "email": "new@example.com",
                "code": "123456",
                "source": "web",
                "invite_code": "inv",
            },
        )
    assert response.status_code == 200
    assert response.json()["data"]["sign_in_token"] == "tok"
    register.assert_awaited_once_with(
        email="new@example.com",
        code="123456",
        client_ip="1.2.3.4",
        source="web",
        invite_code="inv",
    )


def test_register_existing_user_is_conflict() -> None:
    with patch(
        "app.controller.v2.auth.AuthService.register_with_code",
        new=AsyncMock(side_effect=InvalidCodeError("该邮箱已注册,请直接登录")),
    ):
        response = client().post(
            "/api/v2/auth/register-with-code",
            json={"email": "user@example.com", "code": "123456"},
        )
    assert response.status_code == 409
    assert "已注册" in response.json()["msg"]


def test_login_with_password_hides_which_check_failed() -> None:
    payload = {"ticket": "ticket-2", "user_id": "user_2"}
    with patch(
        "app.controller.v2.auth.AuthService.login_with_password",
        new=AsyncMock(return_value=payload),
    ):
        ok = client().post(
            "/api/v2/auth/login-with-password",
            json={"email": "user@example.com", "password": "secret"},
        )
    assert ok.status_code == 200
    assert ok.json()["data"] == payload

    with patch(
        "app.controller.v2.auth.AuthService.login_with_password",
        new=AsyncMock(side_effect=InvalidPasswordError("邮箱或密码错误")),
    ):
        bad = client().post(
            "/api/v2/auth/login-with-password",
            json={"email": "user@example.com", "password": "nope"},
        )
    assert bad.status_code == 401
    assert bad.json()["msg"] == "邮箱或密码错误"

    with patch(
        "app.controller.v2.auth.AuthService.login_with_password",
        new=AsyncMock(side_effect=UserNotFoundError("邮箱或密码错误")),
    ):
        missing = client().post(
            "/api/v2/auth/login-with-password",
            json={"email": "user@example.com", "password": "nope"},
        )
    assert missing.status_code == 401
    assert missing.json()["msg"] == "邮箱或密码错误"
