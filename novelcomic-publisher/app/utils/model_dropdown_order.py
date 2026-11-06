"""Build model dropdown groups from stored model config documents."""

from datetime import datetime
from typing import Any

from pydantic import ValidationError

from app.schemas.model_dropdown_order import (
    CONFIG_NAME_TO_GROUP,
    DEFAULT_IMAGE_BRANDS,
    DEFAULT_VIDEO_BRANDS,
    DROPDOWN_GROUP_META,
    DROPDOWN_GROUP_NAMES,
    BrandOrder,
    DropdownGroup,
    DropdownModelItem,
    DropdownOrderResponse,
)

_MISSING_RELEASED_AT = datetime.max
_UNKNOWN_BRAND_INDEX = 10_000


def normalize_brand(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    slug = value.strip().casefold().replace("-", "_").replace(" ", "_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_")


def normalize_brand_list(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        brand = normalize_brand(raw)
        if not brand or brand in seen:
            continue
        seen.add(brand)
        result.append(brand)
    return result


def default_brand_order() -> BrandOrder:
    return BrandOrder(image=list(DEFAULT_IMAGE_BRANDS), video=list(DEFAULT_VIDEO_BRANDS))


def parse_released_at(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        candidate = text[:19] if fmt != "%Y-%m-%d" else text[:10]
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue
    return None


def format_released_at(value: Any) -> str | None:
    parsed = parse_released_at(value)
    if parsed is None:
        return value.strip() if isinstance(value, str) and value.strip() else None
    return parsed.strftime("%Y-%m-%d")


def infer_dropdown_groups(doc: dict[str, Any]) -> list[str]:
    explicit = doc.get("dropdown_groups")
    if isinstance(explicit, list):
        groups: list[str] = []
        seen: set[str] = set()
        for item in explicit:
            if item not in DROPDOWN_GROUP_NAMES or item in seen:
                continue
            seen.add(item)
            groups.append(item)
        if groups:
            return groups
    inferred = CONFIG_NAME_TO_GROUP.get(doc.get("config_name"))
    return [inferred] if inferred else []


def _brand_index(brand: str | None, brand_order: list[str]) -> tuple[int, str]:
    normalized = normalize_brand(brand)
    if not normalized:
        return (_UNKNOWN_BRAND_INDEX + 1, "")
    try:
        return (brand_order.index(normalized), normalized)
    except ValueError:
        return (_UNKNOWN_BRAND_INDEX, normalized)


def sort_models_for_media_kind(
    models: list[DropdownModelItem],
    media_kind: str,
    brand_order: BrandOrder,
) -> list[DropdownModelItem]:
    order_list = brand_order.image if media_kind == "image" else brand_order.video

    def sort_key(item: DropdownModelItem) -> tuple[int, str, int, datetime, str]:
        brand_idx, brand_slug = _brand_index(item.brand, order_list)
        released = parse_released_at(item.released_at) or _MISSING_RELEASED_AT
        return (brand_idx, brand_slug, item.sort_in_brand, released, item.model_id)

    return sorted(models, key=sort_key)


def _to_dropdown_item(doc: dict[str, Any]) -> DropdownModelItem | None:
    model_id = doc.get("model_id")
    config_name = doc.get("config_name")
    if not isinstance(model_id, str) or not model_id:
        return None
    if not isinstance(config_name, str) or not config_name:
        return None

    params = doc.get("params") if isinstance(doc.get("params"), dict) else {}
    input_mapping = doc.get("input_mapping")
    if not isinstance(input_mapping, dict):
        input_mapping = None

    sort_in_brand = doc.get("sort_in_brand")
    if not isinstance(sort_in_brand, int) or isinstance(sort_in_brand, bool):
        sort_in_brand = 0

    display_name = doc.get("display_name")
    if not isinstance(display_name, str) or not display_name.strip():
        display_name = model_id

    try:
        return DropdownModelItem(
            config_name=config_name,
            model_id=model_id,
            display_name=display_name,
            brand=normalize_brand(doc.get("brand")) or None,
            released_at=format_released_at(doc.get("released_at")),
            sort_in_brand=sort_in_brand,
            dropdown_groups=infer_dropdown_groups(doc) or None,
            pricing=doc.get("pricing"),
            params=params,
            input_mapping=input_mapping,
        )
    except ValidationError:
        return None


def build_dropdown_order(
    *,
    brand_order: BrandOrder,
    model_docs: list[dict[str, Any]],
    group: str | None = None,
) -> DropdownOrderResponse:
    selected_groups = DROPDOWN_GROUP_NAMES
    if group and group != "all":
        selected_groups = (group,) if group in DROPDOWN_GROUP_META else ()

    buckets: dict[str, list[DropdownModelItem]] = {name: [] for name in selected_groups}
    for doc in model_docs:
        item = _to_dropdown_item(doc)
        if item is None:
            continue
        for group_name in infer_dropdown_groups(doc):
            if group_name in buckets:
                buckets[group_name].append(item)

    groups: dict[str, DropdownGroup] = {}
    for group_name in selected_groups:
        meta = DROPDOWN_GROUP_META[group_name]
        media_kind = meta["media_kind"]
        groups[group_name] = DropdownGroup(
            group=group_name,
            media_kind=media_kind,
            frontend_category=meta["frontend_category"],
            models=sort_models_for_media_kind(buckets[group_name], media_kind, brand_order),
        )

    return DropdownOrderResponse(brand_order=brand_order, groups=groups)
