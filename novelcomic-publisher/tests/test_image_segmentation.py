import time
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.services.image_segmentation import AliyunSegmentResult, ImageSegmentationService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


class FakeConnections:
    def __init__(self) -> None:
        self.mongo = {}

    async def close(self) -> None:
        return None


def _client() -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections()
    return TestClient(app)


def _token(sub: str = "user_abc") -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {_token()}"}


def test_segment_common_image_returns_persisted_result(monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "cos_cdn_domain", "cdn.test")
    monkeypatch.setattr(settings, "image_segmentation_credit_balance", None)

    calls: list[SimpleNamespace] = []

    async def fake_call(*, image_url: str, return_form: str | None) -> AliyunSegmentResult:
        calls.append(SimpleNamespace(image_url=image_url, return_form=return_form))
        return AliyunSegmentResult(image_url="https://aliyun.test/result.png", request_id="req-1")

    async def fake_persist(*, result_url: str) -> tuple[str, str]:
        assert result_url == "https://aliyun.test/result.png"
        return "https://cdn.test/images/segmentation/seg.png", "images/segmentation/seg.png"

    monkeypatch.setattr(ImageSegmentationService, "_call_aliyun_segment_common_image", fake_call)
    monkeypatch.setattr(ImageSegmentationService, "_persist_aliyun_result", fake_persist)

    response = _client().post(
        "/api/v3/image-segmentation/common",
        headers=_auth(),
        json={"image_url": "https://cdn.test/source.png", "return_form": "crop"},
    )

    assert response.status_code == 200
    assert calls == [SimpleNamespace(image_url="https://cdn.test/source.png", return_form="crop")]
    data = response.json()["data"]
    assert data["source_image_url"] == "https://cdn.test/source.png"
    assert data["result_url"] == "https://cdn.test/images/segmentation/seg.png"
    assert data["object_key"] == "images/segmentation/seg.png"
    assert data["provider"] == "aliyun"
    assert data["provider_request_id"] == "req-1"
    assert data["credits_charged"] >= 1


def test_segment_common_image_stops_before_provider_when_credits_are_insufficient(
    monkeypatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "image_segmentation_credit_balance", 0)
    provider_called = False

    async def fake_call(*, image_url: str, return_form: str | None) -> AliyunSegmentResult:
        nonlocal provider_called
        provider_called = True
        return AliyunSegmentResult(image_url=image_url, request_id=return_form)

    monkeypatch.setattr(ImageSegmentationService, "_call_aliyun_segment_common_image", fake_call)

    response = _client().post(
        "/api/v3/image-segmentation/common",
        headers=_auth(),
        json={"image_url": "https://cdn.test/source.png"},
    )

    assert response.status_code == 402
    assert response.json()["msg"] == "Insufficient credits"
    assert provider_called is False
