"""CLI device authorization and ak_ token lifecycle service."""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import HTTPException

from app.config import get_settings

CLI_DEVICE_AUTH_COLLECTION = "cli_device_authorizations"
CLI_TOKEN_COLLECTION = "cli_access_tokens"
DEVICE_CODE_TTL_SECONDS = 600
POLL_INTERVAL_SECONDS = 5
_HUMAN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_user_code(value: str) -> str:
    cleaned = "".join(ch for ch in value.upper() if ch.isalnum())
    if len(cleaned) == 8:
        return f"{cleaned[:4]}-{cleaned[4:]}"
    return value.strip().upper()


def _generate_user_code() -> str:
    chars = "".join(secrets.choice(_HUMAN_ALPHABET) for _ in range(8))
    return f"{chars[:4]}-{chars[4:]}"


class CliDeviceAuthService:
    @staticmethod
    async def create_device_code(
        database: Any,
        *,
        client_name: str = "OpenCreator CLI",
        device_name: str | None = None,
        os_info: str | None = None,
    ) -> dict[str, Any]:
        device_code = f"dc_{secrets.token_urlsafe(24)}"
        user_code = _generate_user_code()
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=DEVICE_CODE_TTL_SECONDS)
        settings = get_settings()
        base_url = getattr(settings, "frontend_url", "http://localhost:5173").rstrip("/")
        verification_uri = f"{base_url}/cli/authorize"
        verification_uri_complete = f"{verification_uri}#code={urlencode({'c': user_code})[2:]}"

        doc = {
            "authorization_id": f"cauth_{uuid4().hex[:16]}",
            "device_code_hash": _hash_value(device_code),
            "user_code": user_code,
            "client_name": client_name,
            "device_name": device_name or "CLI Terminal",
            "os_info": os_info or "",
            "status": "pending",
            "user_id": None,
            "created_at": now,
            "expires_at": expires_at,
            "updated_at": now,
        }
        await database[CLI_DEVICE_AUTH_COLLECTION].insert_one(doc)
        return {
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": verification_uri,
            "verification_uri_complete": verification_uri_complete,
            "expires_in": DEVICE_CODE_TTL_SECONDS,
            "interval": POLL_INTERVAL_SECONDS,
        }

    @staticmethod
    async def get_device_authorization_by_user_code(
        database: Any,
        *,
        user_code: str,
    ) -> dict[str, Any]:
        normalized = _normalize_user_code(user_code)
        doc = await database[CLI_DEVICE_AUTH_COLLECTION].find_one({"user_code": normalized})
        if doc is None:
            raise HTTPException(status_code=404, detail="Device authorization code not found")
        expires_at = doc.get("expires_at")
        now = datetime.now(UTC)
        if isinstance(expires_at, datetime):
            exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            if exp_utc <= now and doc.get("status") == "pending":
                await database[CLI_DEVICE_AUTH_COLLECTION].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"status": "expired", "updated_at": now}},
                )
                doc["status"] = "expired"
        return {
            "authorization_id": doc.get("authorization_id"),
            "user_code": doc.get("user_code"),
            "client_name": doc.get("client_name") or "OpenCreator CLI",
            "device_name": doc.get("device_name") or "CLI Terminal",
            "os_info": doc.get("os_info") or "",
            "status": doc.get("status") or "pending",
            "expires_at": doc.get("expires_at").isoformat()
            if isinstance(doc.get("expires_at"), datetime)
            else doc.get("expires_at"),
        }

    @staticmethod
    async def decide_device_authorization(
        database: Any,
        *,
        user_id: str,
        user_code: str,
        action: str,
    ) -> dict[str, Any]:
        normalized = _normalize_user_code(user_code)
        doc = await database[CLI_DEVICE_AUTH_COLLECTION].find_one({"user_code": normalized})
        if doc is None:
            raise HTTPException(status_code=404, detail="Device authorization code not found")

        now = datetime.now(UTC)
        expires_at = doc.get("expires_at")
        if isinstance(expires_at, datetime):
            exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            if exp_utc <= now:
                raise HTTPException(status_code=400, detail="expired_token")

        if doc.get("status") not in {"pending", "approved"}:
            raise HTTPException(status_code=409, detail=f"Authorization is already {doc.get('status')}")

        new_status = "approved" if action in {"approve", "allow", "approved"} else "denied"
        await database[CLI_DEVICE_AUTH_COLLECTION].update_one(
            {"user_code": normalized},
            {
                "$set": {
                    "status": new_status,
                    "user_id": user_id,
                    "approved_at": now,
                    "updated_at": now,
                }
            },
        )
        return {
            "user_code": normalized,
            "status": new_status,
            "user_id": user_id,
        }

    @staticmethod
    async def exchange_device_token(
        database: Any,
        *,
        device_code: str,
    ) -> dict[str, Any]:
        code_hash = _hash_value(device_code.strip())
        doc = await database[CLI_DEVICE_AUTH_COLLECTION].find_one({"device_code_hash": code_hash})
        if doc is None:
            raise HTTPException(status_code=400, detail="invalid_grant")

        now = datetime.now(UTC)
        expires_at = doc.get("expires_at")
        if isinstance(expires_at, datetime):
            exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
            if exp_utc <= now and doc.get("status") == "pending":
                await database[CLI_DEVICE_AUTH_COLLECTION].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"status": "expired", "updated_at": now}},
                )
                raise HTTPException(status_code=400, detail="expired_token")

        status = doc.get("status")
        if status == "pending":
            raise HTTPException(status_code=400, detail="authorization_pending")
        if status == "denied":
            raise HTTPException(status_code=400, detail="access_denied")
        if status == "expired":
            raise HTTPException(status_code=400, detail="expired_token")
        if status == "consumed":
            raise HTTPException(status_code=400, detail="invalid_grant")
        if status != "approved" or not doc.get("user_id"):
            raise HTTPException(status_code=400, detail="invalid_grant")

        access_token = f"ak_{secrets.token_urlsafe(28)}"
        token_hash = _hash_value(access_token)
        token_doc = {
            "token_id": f"clitok_{uuid4().hex[:16]}",
            "token_hash": token_hash,
            "token_suffix": access_token[-4:],
            "user_id": str(doc["user_id"]),
            "client_name": doc.get("client_name") or "OpenCreator CLI",
            "device_name": doc.get("device_name") or "CLI Terminal",
            "status": "active",
            "created_at": now,
            "updated_at": now,
        }
        await database[CLI_TOKEN_COLLECTION].insert_one(token_doc)
        await database[CLI_DEVICE_AUTH_COLLECTION].update_one(
            {"_id": doc["_id"]},
            {"$set": {"status": "consumed", "consumed_at": now, "updated_at": now}},
        )
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "user_id": str(doc["user_id"]),
        }

    @staticmethod
    async def authenticate_ak_token(
        database: Any,
        *,
        authorization_header: str | None,
    ) -> dict[str, Any]:
        if not authorization_header or not authorization_header.strip():
            raise HTTPException(status_code=401, detail="Missing CLI access token")
        raw = authorization_header.strip()
        if raw.lower().startswith("bearer "):
            raw = raw[7:].strip()
        if not raw.startswith("ak_"):
            raise HTTPException(status_code=401, detail="Invalid CLI access token")
        token_hash = _hash_value(raw)
        token_doc = await database[CLI_TOKEN_COLLECTION].find_one(
            {"token_hash": token_hash, "status": "active"}
        )
        if token_doc is None:
            raise HTTPException(status_code=401, detail="Invalid or revoked CLI access token")
        return dict(token_doc)

    @staticmethod
    async def get_cli_info(
        database: Any,
        *,
        token_doc: dict[str, Any],
    ) -> dict[str, Any]:
        user_id = str(token_doc["user_id"])
        user = await database["user"].find_one({"id": user_id}) or {}
        credits = await database["credits"].find_one({"user_id": user_id}) or {}
        total_credits = (
            int(credits.get("sub_credits", 0) or 0)
            + int(credits.get("for_ever_credits", 0) or 0)
            + int(credits.get("gift_credits", 0) or 0)
            + int(credits.get("limit_credits", 0) or 0)
        )
        email = ""
        email_addresses = user.get("email_addresses")
        if isinstance(email_addresses, list) and email_addresses:
            first = email_addresses[0]
            if isinstance(first, dict):
                email = str(first.get("email_address") or "")
        return {
            "user_id": user_id,
            "username": user.get("username") or user.get("first_name") or user_id,
            "email": email or user.get("email") or "",
            "credits": total_credits,
            "client_name": token_doc.get("client_name") or "OpenCreator CLI",
            "device_name": token_doc.get("device_name") or "CLI Terminal",
        }

    @staticmethod
    async def revoke_ak_token(
        database: Any,
        *,
        token_doc: dict[str, Any],
    ) -> None:
        await database[CLI_TOKEN_COLLECTION].update_one(
            {"token_hash": token_doc["token_hash"]},
            {"$set": {"status": "revoked", "updated_at": datetime.now(UTC)}},
        )
