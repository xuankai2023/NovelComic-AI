"""Public Agent catalog orchestration."""

from typing import Any

from app.dao.agent_catalog import AgentCatalogDao
from app.schemas.agent_catalog import AgentCatalogHook, AgentCatalogPage, AgentCatalogRole

_DEFAULT_PAGE_SIZE = 20
_MAX_PAGE_SIZE = 100


def _normalize_page(page_number: int, page_size: int) -> tuple[int, int]:
    page = max(page_number, 1)
    size = min(max(page_size, 1), _MAX_PAGE_SIZE)
    return page, size


def _item_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    published_at = (
        item.get("published_at")
        or item.get("updated_at")
        or item.get("created_at")
        or ""
    )
    return (int(item.get("sort_order") or 0), str(published_at))


def _exclude_set(exclude_ids: list[str] | None) -> set[str]:
    return {item.strip() for item in exclude_ids or [] if item.strip()}


class AgentCatalogService:
    @staticmethod
    async def list_hooks(
        database: Any,
        *,
        hook_type: str | None = None,
        page_number: int = 1,
        page_size: int = _DEFAULT_PAGE_SIZE,
        exclude_ids: list[str] | None = None,
    ) -> AgentCatalogPage:
        docs = await AgentCatalogDao.list_published(database, "hook")
        excluded = _exclude_set(exclude_ids)
        items = [
            AgentCatalogHook(**doc).model_dump(mode="json")
            for doc in docs
            if (not hook_type or doc.get("hook_type") == hook_type)
            and doc.get("hook_id") not in excluded
        ]
        return AgentCatalogService._paginate(items, page_number=page_number, page_size=page_size)

    @staticmethod
    async def list_roles(
        database: Any,
        *,
        page_number: int = 1,
        page_size: int = _DEFAULT_PAGE_SIZE,
        exclude_ids: list[str] | None = None,
    ) -> AgentCatalogPage:
        docs = await AgentCatalogDao.list_published(database, "role")
        excluded = _exclude_set(exclude_ids)
        items = [
            AgentCatalogRole(**doc).model_dump(mode="json")
            for doc in docs
            if doc.get("role_id") not in excluded
        ]
        return AgentCatalogService._paginate(items, page_number=page_number, page_size=page_size)

    @staticmethod
    def _paginate(
        items: list[dict[str, Any]],
        *,
        page_number: int,
        page_size: int,
    ) -> AgentCatalogPage:
        page, size = _normalize_page(page_number, page_size)
        sorted_items = sorted(items, key=_item_sort_key, reverse=True)
        start = (page - 1) * size
        end = start + size
        return AgentCatalogPage(
            items=sorted_items[start:end],
            total=len(sorted_items),
            page=page,
            pageSize=size,
        )
