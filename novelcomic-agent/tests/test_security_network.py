"""SSRF checks for outbound agent fetches."""

from __future__ import annotations

import socket
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from novelcomic_agent.core.tools.web import WebFetchTool
from novelcomic_agent.providers.remote_image import download_remote_image
from novelcomic_agent.security.network import (
    contains_internal_url,
    validate_resolved_url,
    validate_url_target,
)


def _fake_resolve(mapping: dict[str, list[str]]):
    def _resolver(hostname: str, port: int | None, family: int = 0, type_: int = 0):
        addresses = mapping.get(hostname)
        if addresses is None:
            raise socket.gaierror(f"cannot resolve {hostname}")
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 0))
            for ip in addresses
        ]

    return _resolver


def _resolve_one(host: str, ips: list[str]):
    return _fake_resolve({host: ips})


@pytest.mark.parametrize(
    "url",
    ["ftp://example.com/file", "file:///etc/passwd", "http://", "gopher://example.com"],
)
def test_validate_url_target_rejects_bad_scheme_or_host(url: str) -> None:
    ok, error = validate_url_target(url)
    assert not ok
    assert error


def test_validate_url_target_rejects_unresolvable_host() -> None:
    with patch("novelcomic_agent.security.network.socket.getaddrinfo", _fake_resolve({})):
        ok, error = validate_url_target("https://missing.example/page")
        assert not ok
        assert "missing.example" in error


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.5.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.1.2.3",
    ],
)
def test_validate_url_target_blocks_private_ipv4(ip: str) -> None:
    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("evil.com", [ip]),
    ):
        ok, error = validate_url_target("http://evil.com/path")
        assert not ok
        assert "private" in error.lower() or "blocked" in error.lower()


@pytest.mark.parametrize("ip", ["::1", "fc00::1", "fd12::1", "fe80::1"])
def test_validate_url_target_blocks_private_ipv6(ip: str) -> None:
    def _resolver(hostname: str, port: int | None, family: int = 0, type_: int = 0):
        return [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", (ip, 0, 0, 0))]

    with patch("novelcomic_agent.security.network.socket.getaddrinfo", _resolver):
        ok, _error = validate_url_target("http://evil.com/")
        assert not ok


def test_validate_url_target_allows_public_https() -> None:
    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("example.com", ["93.184.216.34"]),
    ):
        ok, error = validate_url_target("https://example.com/page")
        assert ok
        assert error == ""


def test_validate_resolved_url_blocks_literal_private_redirect() -> None:
    ok, error = validate_resolved_url("http://169.254.169.254/latest/meta-data")
    assert not ok
    assert "169.254.169.254" in error


def test_validate_resolved_url_allows_unresolvable_hostname() -> None:
    with patch("novelcomic_agent.security.network.socket.getaddrinfo", _fake_resolve({})):
        ok, error = validate_resolved_url("https://gone.example/after")
        assert ok
        assert error == ""


def test_validate_resolved_url_blocks_hostname_that_resolves_private() -> None:
    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("redirect.example", ["10.0.0.8"]),
    ):
        ok, error = validate_resolved_url("http://redirect.example/secret")
        assert not ok
        assert "10.0.0.8" in error


def test_contains_internal_url_scans_command_strings() -> None:
    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _fake_resolve(
            {
                "169.254.169.254": ["169.254.169.254"],
                "example.com": ["93.184.216.34"],
            }
        ),
    ):
        assert contains_internal_url("curl -s http://169.254.169.254/computeMetadata/v1/")
        assert not contains_internal_url("curl https://example.com/api/data")
    assert not contains_internal_url("echo hello && ls -la")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.8/secret",
    ],
)
async def test_web_fetch_rejects_internal_targets_before_connect(url: str) -> None:
    def _client(requested: str) -> str:
        raise AssertionError(f"client should not be called for {requested}")

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _fake_resolve(
            {
                "127.0.0.1": ["127.0.0.1"],
                "169.254.169.254": ["169.254.169.254"],
                "10.0.0.8": ["10.0.0.8"],
            }
        ),
    ):
        result = await WebFetchTool(_client).execute(url=url)

    assert result.startswith("Error: URL validation failed:")


async def test_web_fetch_returns_public_page() -> None:
    seen: list[str] = []

    def _client(requested: str) -> str:
        seen.append(requested)
        return "public page"

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("example.com", ["93.184.216.34"]),
    ):
        result = await WebFetchTool(_client).execute(url="https://example.com/page")

    assert seen == ["https://example.com/page"]
    assert result == "public page"


async def test_web_fetch_rejects_redirect_to_internal_url() -> None:
    def _client(requested: str) -> Any:
        return SimpleNamespace(url="http://10.0.0.8/secret", text="internal-body")

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _fake_resolve(
            {
                "example.com": ["93.184.216.34"],
                "10.0.0.8": ["10.0.0.8"],
            }
        ),
    ):
        result = await WebFetchTool(_client).execute(url="https://example.com/start")

    assert result.startswith("Error: Redirect blocked:")
    assert "internal-body" not in result


async def test_web_fetch_allows_redirect_when_final_host_does_not_resolve() -> None:
    def _client(requested: str) -> Any:
        return {"final_url": "https://gone.example/next", "text": "still here"}

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("example.com", ["93.184.216.34"]),
    ):
        result = await WebFetchTool(_client).execute(url="https://example.com/start")

    assert result == "still here"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/pixel.png",
        "http://169.254.169.254/latest/meta-data",
        "http://10.2.3.4/pixel.png",
    ],
)
def test_remote_image_rejects_internal_targets_before_connect(url: str) -> None:
    def _fetch(requested: str) -> bytes:
        raise AssertionError(f"fetch should not be called for {requested}")

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _fake_resolve(
            {
                "127.0.0.1": ["127.0.0.1"],
                "169.254.169.254": ["169.254.169.254"],
                "10.2.3.4": ["10.2.3.4"],
            }
        ),
    ):
        assert download_remote_image(url, _fetch) is None


def test_remote_image_returns_public_bytes() -> None:
    payload = b"\x89PNG"

    def _fetch(requested: str) -> Any:
        return SimpleNamespace(url=requested, content=payload)

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("cdn.example", ["93.184.216.34"]),
    ):
        assert download_remote_image("https://cdn.example/a.png", _fetch) == payload


def test_remote_image_rejects_redirect_to_metadata_address() -> None:
    def _fetch(requested: str) -> Any:
        return SimpleNamespace(url="http://169.254.169.254/latest", content=b"secret")

    with patch(
        "novelcomic_agent.security.network.socket.getaddrinfo",
        _resolve_one("cdn.example", ["93.184.216.34"]),
    ):
        assert download_remote_image("https://cdn.example/a.png", _fetch) is None
