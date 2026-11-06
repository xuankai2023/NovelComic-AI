"""Template marketplace service with 60s category count cache."""

from __future__ import annotations

import time
from typing import Any

from app.dao.template import TemplateDao

_CATEGORY_CACHE_TTL_SECONDS = 60.0
_category_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


class TemplateService:
    @classmethod
    def clear_cache(cls) -> None:
        _category_cache.clear()

    @classmethod
    async def get_template_page(
        cls,
        database: Any,
        *,
        page_number: int = 1,
        page_size: int = 20,
        keyword: str | None = None,
        is_recommend: bool | None = None,
        category: str | None = None,
        sort_by: str | None = None,
    ) -> dict[str, Any]:
        return await TemplateDao.get_template_page(
            database,
            page_number=page_number,
            page_size=page_size,
            keyword=keyword,
            is_recommend=is_recommend,
            category=category,
            sort_by=sort_by,
        )

    @classmethod
    async def get_template_by_id(cls, database: Any, template_id: str) -> dict[str, Any] | None:
        return await TemplateDao.get_template_by_id(database, template_id)

    @classmethod
    async def list_categories(cls, database: Any) -> list[dict[str, Any]]:
        cache_key = str(id(database))
        now = time.monotonic()
        cached = _category_cache.get(cache_key)
        if cached and (now - cached[0]) < _CATEGORY_CACHE_TTL_SECONDS:
            return cached[1]

        categories = await TemplateDao.list_categories(database)
        page_meta = await TemplateDao.get_template_page(database, page_number=1, page_size=1)
        counts = page_meta.get("category_counts") or {}
        enriched: list[dict[str, Any]] = []
        for cat in categories:
            key = str(cat.get("path") or cat.get("id") or "")
            enriched.append(
                {
                    **cat,
                    "template_count": int(counts.get(key, cat.get("template_count") or 0)),
                }
            )
        _category_cache[cache_key] = (now, enriched)
        return enriched
