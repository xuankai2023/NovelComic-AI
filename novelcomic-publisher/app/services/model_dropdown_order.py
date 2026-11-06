"""Model dropdown order service."""

from typing import Any

from app.dao.model_config import ModelConfigDao
from app.dao.model_sort_config import ModelSortConfigDao
from app.schemas.model_dropdown_order import (
    DROPDOWN_GROUP_NAMES,
    BrandOrder,
    DropdownOrderResponse,
)
from app.schemas.request_schemas.model_dropdown_order_request import ModelSortItemRequest
from app.utils.model_dropdown_order import (
    build_dropdown_order,
    normalize_brand,
    normalize_brand_list,
)


class ModelDropdownOrderService:
    @staticmethod
    def is_valid_group(group: str | None) -> bool:
        return group in (None, "", "all", *DROPDOWN_GROUP_NAMES)

    @classmethod
    async def get_dropdown_order(
        cls,
        database: Any,
        group: str | None = None,
    ) -> DropdownOrderResponse:
        brand_order = await ModelSortConfigDao.get_brand_order(database)
        models = await ModelConfigDao.find_all(database)
        return build_dropdown_order(brand_order=brand_order, model_docs=models, group=group)

    @classmethod
    async def upsert_brand_order(
        cls,
        database: Any,
        image: list[str],
        video: list[str],
    ) -> BrandOrder:
        image_brands = normalize_brand_list(image)
        video_brands = normalize_brand_list(video)
        if not image_brands or not video_brands:
            raise ValueError("image / video brand order cannot be empty")
        return await ModelSortConfigDao.upsert_brand_order(database, image_brands, video_brands)

    @classmethod
    async def batch_update_models(
        cls,
        database: Any,
        items: list[ModelSortItemRequest],
    ) -> dict[str, list[dict[str, str | None]]]:
        patches = [cls._build_sort_patch(item) for item in items]
        return await ModelConfigDao.update_sort_fields(database, patches)

    @staticmethod
    def _build_sort_patch(item: ModelSortItemRequest) -> dict[str, Any]:
        payload = item.model_dump(exclude_unset=True)
        set_fields: dict[str, Any] = {}
        unset_fields: dict[str, str] = {}

        if "brand" in payload:
            brand = normalize_brand(payload.get("brand"))
            if brand:
                set_fields["brand"] = brand
            else:
                unset_fields["brand"] = ""

        if "released_at" in payload:
            released_at = payload.get("released_at")
            if released_at:
                set_fields["released_at"] = released_at
            else:
                unset_fields["released_at"] = ""

        if "sort_in_brand" in payload and payload.get("sort_in_brand") is not None:
            set_fields["sort_in_brand"] = payload["sort_in_brand"]

        if "dropdown_groups" in payload:
            groups = payload.get("dropdown_groups")
            if groups:
                set_fields["dropdown_groups"] = groups
            else:
                unset_fields["dropdown_groups"] = ""

        return {
            "config_name": item.config_name,
            "model_id": item.model_id,
            "set": set_fields,
            "unset": unset_fields,
        }
