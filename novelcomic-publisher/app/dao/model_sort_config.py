"""Mongo access for model dropdown brand ordering."""

from datetime import UTC, datetime
from typing import Any

from app.schemas.model_dropdown_order import BrandOrder
from app.utils.model_dropdown_order import default_brand_order, normalize_brand_list

_BRAND_ORDER_KEY = "brand_order"


class ModelSortConfigDao:
    collection_name = "model_sort_configs"

    @classmethod
    async def get_brand_order(cls, database: Any) -> BrandOrder:
        doc = await database[cls.collection_name].find_one({"key": _BRAND_ORDER_KEY}, {"_id": 0})
        if not doc:
            return default_brand_order()

        image = normalize_brand_list(doc.get("image") or [])
        video = normalize_brand_list(doc.get("video") or [])
        fallback = default_brand_order()
        return BrandOrder(
            image=image or fallback.image,
            video=video or fallback.video,
        )

    @classmethod
    async def upsert_brand_order(
        cls,
        database: Any,
        image: list[str],
        video: list[str],
    ) -> BrandOrder:
        brand_order = BrandOrder(
            image=normalize_brand_list(image),
            video=normalize_brand_list(video),
        )
        await database[cls.collection_name].update_one(
            {"key": _BRAND_ORDER_KEY},
            {
                "$set": {
                    "key": _BRAND_ORDER_KEY,
                    "image": brand_order.image,
                    "video": brand_order.video,
                    "updated_at": datetime.now(UTC),
                }
            },
            upsert=True,
        )
        return brand_order
