"""Media face verification persistence and enqueue orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import httpx

from app.config import get_settings
from app.schemas.media_face_verification import (
    FaceProviderState,
    FetchMediaFaceVerificationsRequest,
    FetchMediaFaceVerificationsResponse,
    IngestMediaFaceVerificationRequest,
    IngestMediaFaceVerificationResponse,
    MediaFaceVerificationItem,
    MediaVerificationStatus,
)
from app.services.assets import AssetLibraryServiceError, AssetsService


@dataclass(frozen=True)
class BytePlusAssetInfo:
    asset_id: str
    group_id: str | None = None
    asset_name: str | None = None
    asset_url: str | None = None


class MediaFaceVerificationServiceError(Exception):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class MediaFaceVerificationService:
    BYTEPLUS_PROVIDER = "byteplus"

    @classmethod
    async def ingest(
        cls,
        *,
        database: Any,
        request: IngestMediaFaceVerificationRequest,
        user_id: str,
    ) -> IngestMediaFaceVerificationResponse:
        url = cls._validate_media_url(request.url)
        collection = database["media_face_verifications"]
        existing = await collection.find_one({"user_id": user_id, "media.url": url}, {"_id": 0})
        if existing:
            if cls._should_retry_failed_record(existing):
                status = await cls._create_asset_and_enqueue(
                    database=database,
                    user_id=user_id,
                    media_id=existing["media"]["id"],
                    url=url,
                    media_type=request.type,
                    content_hash=request.content_hash,
                )
                return IngestMediaFaceVerificationResponse(
                    status=status,
                    is_new=False,
                    reused_from_content_hash=False,
                )
            return IngestMediaFaceVerificationResponse(
                status=cls._aggregate_status(existing),
                is_new=False,
                reused_from_content_hash=False,
            )

        reused_state = await cls._find_active_state_by_content_hash(
            collection=collection,
            content_hash=request.content_hash,
        )
        media_id = uuid4().hex
        now = datetime.now(UTC)
        reused = reused_state is not None
        state = (
            reused_state
            if reused_state is not None
            else FaceProviderState(created_at=now, updated_at=now).model_dump(mode="python")
        )
        document = {
            "verification_id": uuid4().hex,
            "user_id": user_id,
            "media": {
                "id": media_id,
                "url": url,
                "type": request.type,
                "content_hash": request.content_hash,
            },
            "face_providers": {cls.BYTEPLUS_PROVIDER: state},
            "created_at": now,
            "updated_at": now,
        }
        await collection.insert_one(document)

        if reused:
            return IngestMediaFaceVerificationResponse(
                status="active",
                is_new=True,
                reused_from_content_hash=True,
            )

        status = await cls._create_asset_and_enqueue(
            database=database,
            user_id=user_id,
            media_id=media_id,
            url=url,
            media_type=request.type,
            content_hash=request.content_hash,
        )
        return IngestMediaFaceVerificationResponse(
            status=status,
            is_new=True,
            reused_from_content_hash=False,
        )

    @classmethod
    async def fetch_status(
        cls,
        *,
        database: Any,
        request: FetchMediaFaceVerificationsRequest,
        user_id: str,
    ) -> FetchMediaFaceVerificationsResponse:
        collection = database["media_face_verifications"]
        cursor = collection.find(
            {"user_id": user_id, "media.url": {"$in": request.urls}},
            {"_id": 0},
        )
        records = await cls._cursor_to_list(cursor, length=len(request.urls))
        by_url = {record.get("media", {}).get("url"): record for record in records}
        items: list[MediaFaceVerificationItem] = []
        for url in request.urls:
            record = by_url.get(url)
            if not record:
                items.append(MediaFaceVerificationItem(url=url, status="not_found"))
                continue
            state = cls._byteplus_state(record)
            items.append(
                MediaFaceVerificationItem(
                    url=url,
                    status=cls._aggregate_status(record),
                    provider=cls.BYTEPLUS_PROVIDER if state else None,
                    content_hash=record.get("media", {}).get("content_hash"),
                    last_error=cls._format_last_error(
                        state.get("last_sync_error") if isinstance(state, dict) else None
                    ),
                    created_at=record.get("created_at"),
                    updated_at=record.get("updated_at"),
                )
            )
        return FetchMediaFaceVerificationsResponse(items=items)

    @staticmethod
    async def _cursor_to_list(cursor: Any, *, length: int | None = None) -> list[dict[str, Any]]:
        if hasattr(cursor, "to_list"):
            return await cursor.to_list(length=length)
        output: list[dict[str, Any]] = []
        async for item in cursor:
            output.append(item)
        return output

    @staticmethod
    def _validate_media_url(url: str) -> str:
        try:
            return AssetsService._validate_owned_media_url(url, field_name="url")
        except AssetLibraryServiceError as exc:
            raise MediaFaceVerificationServiceError(str(exc), status_code=exc.status_code) from exc

    @classmethod
    def _aggregate_status(cls, record: dict[str, Any]) -> MediaVerificationStatus:
        state = cls._byteplus_state(record)
        status = state.get("verification_status") if isinstance(state, dict) else None
        if status in {"pending", "processing", "active", "rejected", "failed", "unknown"}:
            return status
        return "pending"

    @classmethod
    def _byteplus_state(cls, record: dict[str, Any]) -> dict[str, Any] | None:
        providers = record.get("face_providers")
        if not isinstance(providers, dict):
            return None
        state = providers.get(cls.BYTEPLUS_PROVIDER)
        return state if isinstance(state, dict) else None

    @classmethod
    def _should_retry_failed_record(cls, record: dict[str, Any]) -> bool:
        state = cls._byteplus_state(record)
        return bool(
            isinstance(state, dict)
            and state.get("verification_status") == "failed"
            and not state.get("asset_id")
        )

    @classmethod
    async def _find_active_state_by_content_hash(
        cls,
        *,
        collection: Any,
        content_hash: str | None,
    ) -> dict[str, Any] | None:
        if not content_hash:
            return None
        hit = await collection.find_one(
            {
                "media.content_hash": content_hash,
                "face_providers.byteplus.verification_status": "active",
            },
            {"_id": 0},
        )
        state = cls._byteplus_state(hit or {})
        if not state:
            return None
        now = datetime.now(UTC)
        copied = dict(state)
        copied["verification_status"] = "active"
        copied["sync_status"] = "synced"
        copied["created_at"] = now
        copied["updated_at"] = now
        return copied

    @classmethod
    async def _create_asset_and_enqueue(
        cls,
        *,
        database: Any,
        user_id: str,
        media_id: str,
        url: str,
        media_type: str,
        content_hash: str | None,
    ) -> MediaVerificationStatus:
        collection = database["media_face_verifications"]
        now = datetime.now(UTC)
        await collection.update_one(
            {"user_id": user_id, "media.id": media_id},
            {
                "$set": {
                    "media.type": media_type,
                    "media.content_hash": content_hash,
                    "face_providers.byteplus.sync_status": "syncing",
                    "face_providers.byteplus.updated_at": now,
                    "updated_at": now,
                }
            },
        )
        try:
            asset = await cls._create_byteplus_asset(url=url, media_type=media_type)
            await collection.update_one(
                {"user_id": user_id, "media.id": media_id},
                {
                    "$set": {
                        "face_providers.byteplus.asset_id": asset.asset_id,
                        "face_providers.byteplus.group_id": asset.group_id,
                        "face_providers.byteplus.asset_name": asset.asset_name,
                        "face_providers.byteplus.asset_url": asset.asset_url,
                        "face_providers.byteplus.verification_status": "processing",
                        "face_providers.byteplus.sync_status": "syncing",
                        "face_providers.byteplus.last_sync_error": None,
                        "face_providers.byteplus.updated_at": datetime.now(UTC),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            await cls._enqueue_ai_verification(media_url=url, asset_id=asset.asset_id)
            return "processing"
        except Exception as exc:
            await collection.update_one(
                {"user_id": user_id, "media.id": media_id},
                {
                    "$set": {
                        "face_providers.byteplus.verification_status": "failed",
                        "face_providers.byteplus.sync_status": "failed",
                        "face_providers.byteplus.last_sync_error": str(exc),
                        "face_providers.byteplus.updated_at": datetime.now(UTC),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            return "failed"

    @staticmethod
    async def _create_byteplus_asset(*, url: str, media_type: str) -> BytePlusAssetInfo:
        settings = get_settings()
        if not settings.byteplus_create_asset_url:
            raise MediaFaceVerificationServiceError(
                "BytePlus CreateAsset is not configured",
                status_code=503,
            )
        headers = {"Content-Type": "application/json"}
        if settings.byteplus_api_key:
            headers["Authorization"] = f"Bearer {settings.byteplus_api_key}"
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                settings.byteplus_create_asset_url,
                headers=headers,
                json={"url": url, "type": media_type},
            )
            response.raise_for_status()
            payload = response.json()
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        asset_id = data.get("asset_id") or data.get("assetId")
        if not isinstance(asset_id, str) or not asset_id:
            raise MediaFaceVerificationServiceError(
                "BytePlus CreateAsset response missing asset_id"
            )
        return BytePlusAssetInfo(
            asset_id=asset_id,
            group_id=data.get("group_id") or data.get("groupId"),
            asset_name=data.get("asset_name") or data.get("assetName"),
            asset_url=data.get("asset_url") or data.get("assetUrl"),
        )

    @staticmethod
    async def _enqueue_ai_verification(*, media_url: str, asset_id: str) -> None:
        settings = get_settings()
        if not settings.ai_api_base_url:
            return
        base_url = settings.ai_api_base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{base_url}/v1/media-face-verifications/enqueue",
                json={
                    "provider": "byteplus",
                    "items": [{"media_url": media_url, "asset_id": asset_id}],
                },
            )
            response.raise_for_status()

    @staticmethod
    def _format_last_error(error: Any) -> str | None:
        if error is None:
            return None
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
            return str(message) if message else None
        return str(error)
