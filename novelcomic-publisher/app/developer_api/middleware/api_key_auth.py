"""sk_ API key authentication and rate limiting for /api/developer/v1/*."""

import hmac
from typing import Any

from fastapi import HTTPException, Request

from app.config import get_settings
from app.dao.developer_api_client import DeveloperApiClientDao, hash_api_key


def _extract_raw_api_key(request: Request) -> str | None:
    x_api_key = request.headers.get("X-API-Key")
    if x_api_key and x_api_key.strip():
        return x_api_key.strip()
    auth = request.headers.get("Authorization")
    if not auth or not auth.strip():
        return None
    raw = auth.strip()
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return raw


async def get_authenticated_api_client(request: Request) -> dict[str, Any]:
    raw_key = _extract_raw_api_key(request)
    if not raw_key:
        raise HTTPException(status_code=401, detail="Missing API key")
    if not raw_key.startswith("sk_"):
        raise HTTPException(status_code=401, detail="Invalid API key")

    settings = get_settings()
    database = request.app.state.connections.mongo[settings.mongo_database]
    key_hash = hash_api_key(raw_key)
    client_doc = await DeveloperApiClientDao.get_by_key_hash(database, key_hash)
    if client_doc is None:
        raise HTTPException(status_code=401, detail="Invalid API key")

    stored_key = str(client_doc.get("api_key") or "")
    if stored_key and not hmac.compare_digest(stored_key, raw_key):
        raise HTTPException(status_code=401, detail="Invalid API key")

    rate_limit = client_doc.get("rate_limit_per_minute")
    if isinstance(rate_limit, int) and rate_limit > 0:
        redis_client = getattr(request.app.state.connections, "redis", None)
        if redis_client is not None and hasattr(redis_client, "incr"):
            rate_key = f"opencreator:developer_rate:{client_doc['client_id']}"
            count = int(await redis_client.incr(rate_key))
            if count == 1 and hasattr(redis_client, "expire"):
                await redis_client.expire(rate_key, 60)
            if count > rate_limit:
                raise HTTPException(status_code=429, detail="Rate limit exceeded")

    return client_doc
