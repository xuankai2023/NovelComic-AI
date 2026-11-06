"""Personal asset library persistence and generated result classification."""

from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import uuid4

from app.config import get_settings
from app.schemas.assets import (
    CreateAssetLibraryRequest,
    FetchAssetsRequest,
    SinkAssetLibraryItemRequest,
    SinkAssetLibraryRequest,
)
from app.utils.asset_media_info import resolve_media_dimensions


class AssetLibraryServiceError(Exception):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class AssetsService:
    @staticmethod
    def _configured_asset_hosts() -> set[str]:
        settings = get_settings()
        hosts: set[str] = set()
        for value in (
            settings.cos_cdn_domain,
            settings.cos_accelerate_domain,
            settings.s3_domain,
            settings.cloud_front_domain,
        ):
            if not value:
                continue
            parsed = urlparse(value if "://" in value else f"https://{value}")
            if parsed.hostname:
                hosts.add(parsed.hostname.lower())
        if settings.cos_bucket and settings.cos_region:
            hosts.add(f"{settings.cos_bucket}.cos.{settings.cos_region}.myqcloud.com".lower())
        return hosts

    @classmethod
    def _validate_owned_media_url(cls, value: str, *, field_name: str) -> str:
        parsed = urlparse((value or "").strip())
        try:
            port = parsed.port
        except ValueError as exc:
            raise AssetLibraryServiceError(f"{field_name} must be a valid HTTPS URL") from exc
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or port not in {None, 443}
        ):
            raise AssetLibraryServiceError(f"{field_name} must be a valid HTTPS URL")

        hostname = parsed.hostname.lower()
        allowed_hosts = cls._configured_asset_hosts()
        if not allowed_hosts or not any(
            hostname == allowed_host or hostname.endswith(f".{allowed_host}")
            for allowed_host in allowed_hosts
        ):
            raise AssetLibraryServiceError(
                f"{field_name} must point to the configured NovelComic media CDN",
            )
        return parsed.geturl()

    @staticmethod
    def _asset_name_from_url(url: str) -> str:
        parsed = urlparse(url)
        name = unquote(PurePosixPath(parsed.path).name)
        return name[:255] if name else "Untitled asset"

    @staticmethod
    async def _cursor_to_list(cursor: Any, *, length: int | None = None) -> list[dict[str, Any]]:
        if hasattr(cursor, "to_list"):
            return await cursor.to_list(length=length)
        output: list[dict[str, Any]] = []
        async for item in cursor:
            output.append(item)
        return output

    @staticmethod
    def _without_private_fields(document: dict[str, Any]) -> dict[str, Any]:
        result = dict(document)
        result.pop("_id", None)
        result.pop("user_id", None)
        return result

    @classmethod
    async def create_uploaded_asset(
        cls,
        *,
        database: Any,
        request: CreateAssetLibraryRequest,
        user_id: str,
    ) -> dict[str, Any]:
        request.url = cls._validate_owned_media_url(request.url, field_name="url")
        if request.thumbnail_url:
            request.thumbnail_url = cls._validate_owned_media_url(
                request.thumbnail_url,
                field_name="thumbnail_url",
            )
        if not request.name:
            request.name = cls._asset_name_from_url(request.url)

        media_metadata = await resolve_media_dimensions(
            url=request.url,
            media_type=request.media_type,
            resource_info=request.resource_info.model_dump(exclude_none=True)
            if request.resource_info
            else None,
            aspect_ratio=request.aspect_ratio,
        )

        collection = database["asset_library_items"]
        query = {
            "user_id": user_id,
            "library_kind": request.library_kind,
            "url": request.url,
        }
        existing = await collection.find_one(query, {"_id": 0, "user_id": 0})
        if existing is not None:
            if media_metadata:
                current_metadata = (
                    existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
                )
                merged_metadata = dict(current_metadata)
                changed = False
                for key, value in media_metadata.items():
                    if not merged_metadata.get(key):
                        merged_metadata[key] = value
                        changed = True
                if changed:
                    await collection.update_one(
                        query,
                        {
                            "$set": {
                                "metadata": merged_metadata,
                                "updated_at": datetime.now(UTC),
                            }
                        },
                    )
                    existing["metadata"] = merged_metadata
            return existing

        now = datetime.now(UTC)
        doc = {
            "asset_id": uuid4().hex,
            "user_id": user_id,
            "library_kind": request.library_kind,
            "source_kind": "uploaded",
            "media_type": request.media_type,
            "url": request.url,
            "thumbnail_url": request.thumbnail_url,
            "name": request.name or "",
            "upload_context": request.upload_context,
            "metadata": media_metadata,
            "created_at": now,
            "updated_at": now,
        }
        await collection.insert_one(doc)
        doc.pop("_id", None)
        doc.pop("user_id", None)
        return doc

    @classmethod
    async def fetch_assets_page(
        cls,
        *,
        database: Any,
        params: FetchAssetsRequest,
        user_id: str,
    ) -> dict[str, Any]:
        if params.source_kind == "uploaded":
            return await cls._fetch_uploaded_assets_page(
                database=database,
                params=params,
                user_id=user_id,
            )
        return await cls._fetch_generated_assets_page(
            database=database,
            params=params,
            user_id=user_id,
        )

    @classmethod
    async def _fetch_uploaded_assets_page(
        cls,
        *,
        database: Any,
        params: FetchAssetsRequest,
        user_id: str,
    ) -> dict[str, Any]:
        collection = database["asset_library_items"]
        query: dict[str, Any] = {"user_id": user_id, "source_kind": "uploaded"}
        if params.library_kind:
            query["library_kind"] = params.library_kind
        if params.media_type != "all":
            query["media_type"] = params.media_type
        elif params.types:
            accepted_types = [value for value in params.types if value in {"image", "video"}]
            if accepted_types:
                query["media_type"] = {"$in": accepted_types}

        page = params.page
        page_size = params.page_size
        cursor = collection.find(query, {"_id": 0, "user_id": 0}).sort("created_at", -1)
        cursor = cursor.skip((page - 1) * page_size).limit(page_size)
        items = await cls._cursor_to_list(cursor, length=page_size)
        total_count = await collection.count_documents(query)
        output: list[dict[str, Any]] = []
        for asset in items:
            metadata = {
                "library_kind": asset["library_kind"],
                "source_kind": "uploaded",
                "role": asset["library_kind"],
                "asset_kind": asset["library_kind"],
                "output_cdn_url": asset["url"],
                "output_cdn_thumbnail_url": asset.get("thumbnail_url") or "",
                "upload_context": asset.get("upload_context"),
            }
            stored_metadata = (
                asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
            )
            metadata.update(stored_metadata)
            output.append(
                {
                    "type": asset["media_type"],
                    "node_id": "",
                    "result": asset["url"],
                    "prompt": asset.get("name") or "",
                    "model": "",
                    "run_id": "",
                    "created_at": asset["created_at"],
                    "updated_at": asset.get("updated_at") or asset["created_at"],
                    "result_id": asset["asset_id"],
                    "metadata": metadata,
                }
            )
        return cls._fetch_response(output=output, total_count=total_count, retention_days=None)

    @classmethod
    async def _fetch_generated_assets_page(
        cls,
        *,
        database: Any,
        params: FetchAssetsRequest,
        user_id: str,
    ) -> dict[str, Any]:
        collection = database["node_results"]
        query: dict[str, Any] = {"user_id": user_id}
        accepted_types = [value for value in params.types if value in {"image", "video"}]
        if params.media_type != "all":
            query["type"] = params.media_type
        elif accepted_types:
            query["type"] = {"$in": accepted_types}
        else:
            query["type"] = {"$in": ["image", "video"]}

        page = params.page
        page_size = params.page_size
        cursor = collection.find(query, {"_id": 0, "user_id": 0}).sort("created_at", -1)
        cursor = cursor.skip((page - 1) * page_size).limit(page_size)
        items = await cls._cursor_to_list(cursor, length=page_size)
        total_count = await collection.count_documents(query)
        output = [cls._generated_result_to_asset_item(item) for item in items]
        return cls._fetch_response(output=output, total_count=total_count, retention_days=None)

    @staticmethod
    def _fetch_response(
        *,
        output: list[dict[str, Any]],
        total_count: int,
        retention_days: int | None,
    ) -> dict[str, Any]:
        return {
            "output": output,
            "meta": {
                "visible_total_count": total_count,
                "page_count": len(output),
                "hidden_count": 0,
                "total_count": total_count,
                "subscription_level": 0,
                "retention_days": retention_days,
                "server_time": datetime.now(UTC).isoformat(),
            },
        }

    @staticmethod
    def _generated_result_to_asset_item(item: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(UTC)
        metadata = dict(item.get("metadata") or {})
        result_value = item.get("result") or metadata.get("output_cdn_url")
        library_kind = metadata.get("library_kind") or metadata.get("role") or "character"
        metadata.setdefault("source_kind", "generated")
        metadata.setdefault("library_kind", library_kind)
        metadata.setdefault("role", library_kind)
        metadata.setdefault("asset_kind", library_kind)
        if isinstance(result_value, str):
            metadata.setdefault("output_cdn_url", result_value)
        return {
            "type": item.get("type") or "image",
            "node_id": item.get("node_id") or "",
            "result": result_value,
            "prompt": item.get("prompt") or metadata.get("prompt") or "",
            "model": item.get("model") or metadata.get("model") or "",
            "run_id": item.get("run_id") or item.get("workflow_id") or "",
            "created_at": item.get("created_at") or now,
            "updated_at": item.get("updated_at") or item.get("created_at") or now,
            "result_id": item.get("result_id") or item.get("node_result_id") or uuid4().hex,
            "metadata": metadata,
        }

    @classmethod
    async def sink_generated_assets(
        cls,
        *,
        database: Any,
        request: SinkAssetLibraryRequest,
        user_id: str,
    ) -> dict[str, Any]:
        response_items: list[dict[str, str]] = []
        seen_result_ids: set[str] = set()
        for item in request.items:
            item.url = cls._validate_owned_media_url(item.url, field_name="url")
            if item.thumbnail_url:
                item.thumbnail_url = cls._validate_owned_media_url(
                    item.thumbnail_url,
                    field_name="thumbnail_url",
                )
            target = await cls._find_generated_target(database, item, user_id)
            if not target:
                raise AssetLibraryServiceError(
                    "Generated result was not found for the current user",
                    status_code=404,
                )
            if not cls._url_belongs_to_generated_result(item.url, target):
                raise AssetLibraryServiceError(
                    "url does not belong to the selected generated result",
                    status_code=400,
                )
            result_id = str(target.get("result_id") or target.get("node_result_id") or "")
            if not result_id:
                raise AssetLibraryServiceError(
                    "Generated result is missing result_id",
                    status_code=409,
                )
            if result_id in seen_result_ids:
                continue
            seen_result_ids.add(result_id)
            media_metadata = await resolve_media_dimensions(
                url=item.url,
                media_type=item.media_type,
                resource_info=item.resource_info.model_dump(exclude_none=True)
                if item.resource_info
                else None,
                aspect_ratio=item.aspect_ratio,
            )
            updated = await cls._sink_generated_result(
                database=database,
                item=item,
                user_id=user_id,
                result_id=result_id,
                media_metadata=media_metadata,
            )
            if not updated:
                raise AssetLibraryServiceError(
                    "Generated result changed before it could be classified",
                    status_code=409,
                )
            response_items.append(
                {
                    "asset_id": result_id,
                    "library_kind": item.library_kind,
                    "source_kind": "generated",
                    "result_id": result_id,
                }
            )
        return {"sunk_count": len(response_items), "items": response_items}

    @staticmethod
    async def _find_generated_target(
        database: Any,
        item: SinkAssetLibraryItemRequest,
        user_id: str,
    ) -> dict[str, Any] | None:
        collection = database["node_results"]
        if item.result_id:
            return await collection.find_one(
                {"user_id": user_id, "result_id": item.result_id, "type": item.media_type},
                {"_id": 0},
            )
        query = {
            "user_id": user_id,
            "type": item.media_type,
            "$or": [
                {"result": item.url},
                {"metadata.output_cdn_url": item.url},
                {"metadata.source_url": item.url},
            ],
        }
        return await collection.find_one(query, {"_id": 0})

    @staticmethod
    def _url_belongs_to_generated_result(url: str, target: dict[str, Any]) -> bool:
        metadata = target.get("metadata") if isinstance(target.get("metadata"), dict) else {}
        result = target.get("result")
        result_values = result if isinstance(result, list) else [result]
        known_urls = {
            value
            for value in (
                *result_values,
                metadata.get("output_cdn_url"),
                metadata.get("source_url"),
            )
            if isinstance(value, str)
        }
        return not known_urls or url in known_urls

    @staticmethod
    async def _sink_generated_result(
        *,
        database: Any,
        item: SinkAssetLibraryItemRequest,
        user_id: str,
        result_id: str,
        media_metadata: dict[str, Any],
    ) -> bool:
        set_fields: dict[str, Any] = {
            "metadata.source_kind": "generated",
            "metadata.library_kind": item.library_kind,
            "metadata.role": item.library_kind,
            "metadata.asset_kind": item.library_kind,
            "metadata.output_cdn_url": item.url,
            "metadata.asset_name": item.name or "",
            "metadata.classification_source": item.classification_source or "agent",
            "metadata.classification_role": item.classification_role or item.library_kind,
            "updated_at": datetime.now(UTC),
        }
        if item.thumbnail_url:
            set_fields["metadata.output_cdn_thumbnail_url"] = item.thumbnail_url
        resource_info = media_metadata.get("resource_info")
        if isinstance(resource_info, dict) and resource_info:
            set_fields["metadata.resource_info"] = resource_info
        aspect_ratio = media_metadata.get("aspect_ratio")
        if isinstance(aspect_ratio, str) and aspect_ratio:
            set_fields["metadata.aspect_ratio"] = aspect_ratio
        update = await database["node_results"].update_one(
            {"user_id": user_id, "result_id": result_id, "type": item.media_type},
            {"$set": set_fields},
        )
        return bool(update and update.matched_count)
