"""Template marketplace Mongo DAO."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from app.schemas.template import Template

DEFAULT_TEMPLATE_CATEGORIES: list[dict[str, Any]] = [
    {
        "id": "comic-production",
        "path": "comic-production",
        "label": {"zh": "漫剧与漫画创作", "en": "Comic & Drama"},
        "level": 1,
        "parent_id": None,
        "sort_order": 1,
    },
    {
        "id": "character-design",
        "path": "character-design",
        "label": {"zh": "角色与设定", "en": "Character Design"},
        "level": 1,
        "parent_id": None,
        "sort_order": 2,
    },
    {
        "id": "video-generation",
        "path": "video-generation",
        "label": {"zh": "动态分镜与视频", "en": "Storyboard & Video"},
        "level": 1,
        "parent_id": None,
        "sort_order": 3,
    },
]


def _parse_date(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(value, fmt).replace(tzinfo=UTC)
            except ValueError:
                continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            return None
    return None


def _compute_run_count(doc: dict[str, Any]) -> int:
    base_run = int(doc.get("run_count") or 0)
    stats_total = doc.get("stats_total")
    if isinstance(stats_total, dict):
        base_run = max(base_run, int(stats_total.get("run_count") or 0))
    elif isinstance(stats_total, list) and stats_total:
        latest = stats_total[-1]
        if isinstance(latest, dict):
            base_run = max(base_run, int(latest.get("run_count") or 0))
    boost = doc.get("stats_boost")
    boost_run = int((boost or {}).get("run_count") or 0) if isinstance(boost, dict) else 0
    return base_run + boost_run


def _compute_is_trending(doc: dict[str, Any]) -> bool:
    if bool(doc.get("is_trending")):
        return True
    history = doc.get("stats_daily") or doc.get("stats_total")
    if not isinstance(history, list) or len(history) < 2:
        return False
    dated_points: list[tuple[datetime, int]] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        dt = _parse_date(item.get("date") or item.get("stat_date") or item.get("created_at"))
        if dt is None:
            return False
        dated_points.append((dt, int(item.get("run_count") or 0)))
    if len(dated_points) < 2:
        return False
    dated_points.sort(key=lambda pair: pair[0])
    latest_dt, latest_runs = dated_points[-1]
    cutoff = latest_dt - timedelta(days=7)
    baseline_candidates = [runs for dt, runs in dated_points[:-1] if dt >= cutoff]
    if not baseline_candidates:
        return False
    return (latest_runs - baseline_candidates[0]) >= 5


def _interleave_templates(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(docs) <= 1:
        return list(docs)

    by_run = sorted(docs, key=lambda d: _compute_run_count(d), reverse=True)
    by_paid = sorted(
        by_run,
        key=lambda d: float(d.get("acquired_paid_total_amount") or 0),
        reverse=True,
    )
    top_paid = [d for d in by_paid if float(d.get("acquired_paid_total_amount") or 0) > 0][:10]
    top_paid_ids = {d.get("template_id") for d in top_paid}

    remaining = [d for d in by_run if d.get("template_id") not in top_paid_ids]
    latest_sorted = sorted(
        remaining,
        key=lambda d: _parse_date(d.get("updated_at") or d.get("published_at") or d.get("created_at"))
        or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    latest_bucket = latest_sorted[:10]
    latest_ids = {d.get("template_id") for d in latest_bucket}
    run_bucket = [d for d in remaining if d.get("template_id") not in latest_ids]

    merged: list[dict[str, Any]] = list(top_paid)
    latest_idx = 0
    for idx, item in enumerate(run_bucket, start=1):
        merged.append(item)
        if idx % 3 == 0 and latest_idx < len(latest_bucket):
            merged.append(latest_bucket[latest_idx])
            latest_idx += 1
    while latest_idx < len(latest_bucket):
        merged.append(latest_bucket[latest_idx])
        latest_idx += 1
    return merged


def _matches_keyword(doc: dict[str, Any], keyword: str) -> bool:
    needle = keyword.strip().lower()
    if not needle:
        return True
    for field in ("name", "desc"):
        val = doc.get(field)
        if isinstance(val, dict):
            if any(needle in str(text).lower() for text in val.values() if text):
                return True
        elif isinstance(val, str) and needle in val.lower():
            return True
    tags = doc.get("tags") or []
    for tag in tags:
        if isinstance(tag, dict) and any(needle in str(v).lower() for v in tag.values() if v):
            return True
        if isinstance(tag, str) and needle in tag.lower():
            return True
    return False


class TemplateDao:
    COLLECTION = "templates"
    CATEGORIES_COLLECTION = "template_categories"

    @classmethod
    async def list_published_raw(cls, database: Any) -> list[dict[str, Any]]:
        cursor = database[cls.COLLECTION].find(
            {"status": "published"},
            {"_id": 0, "embedding": 0},
        )
        to_list = getattr(cursor, "to_list", None)
        if callable(to_list):
            docs = await to_list(length=2000)
            if not docs and hasattr(cursor, "docs"):
                docs = list(cursor.docs)
        else:
            docs = list(cursor)
        return [dict(d) for d in docs if d.get("status") == "published"]

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
        del sort_by
        all_published = await cls.list_published_raw(database)
        total_records = len(all_published)
        recommend_count = sum(1 for doc in all_published if doc.get("is_recommend"))

        category_counts: dict[str, int] = {}
        seen_pairs: set[tuple[str, str]] = set()
        for doc in all_published:
            tid = str(doc.get("template_id") or "")
            for cat in doc.get("categories") or []:
                cat_str = str(cat).strip()
                if not cat_str:
                    continue
                top = cat_str.split("/")[0]
                for key in {cat_str, top}:
                    if (tid, key) not in seen_pairs:
                        seen_pairs.add((tid, key))
                        category_counts[key] = category_counts.get(key, 0) + 1

        filtered = all_published
        if is_recommend is not None:
            filtered = [d for d in filtered if bool(d.get("is_recommend")) is is_recommend]
        if category and category.strip():
            cat_filter = category.strip()
            filtered = [
                d
                for d in filtered
                if any(
                    str(c) == cat_filter or str(c).startswith(f"{cat_filter}/")
                    for c in (d.get("categories") or [])
                )
            ]
        if keyword and keyword.strip():
            filtered = [d for d in filtered if _matches_keyword(d, keyword)]

        ordered = _interleave_templates(filtered)
        total = len(ordered)
        safe_page = max(1, int(page_number))
        safe_size = max(1, min(int(page_size), 100))
        start = (safe_page - 1) * safe_size
        page_slice = ordered[start : start + safe_size]

        items: list[dict[str, Any]] = []
        for raw in page_slice:
            model = Template(**{**raw, "run_count": _compute_run_count(raw)})
            dumped = model.model_dump(mode="json")
            dumped["is_trending"] = _compute_is_trending(raw)
            items.append(dumped)

        return {
            "items": items,
            "total": total,
            "page_number": safe_page,
            "page_size": safe_size,
            "total_records": total_records,
            "recommend_count": recommend_count,
            "category_counts": category_counts,
        }

    @classmethod
    async def get_template_by_id(cls, database: Any, template_id: str) -> dict[str, Any] | None:
        raw = await database[cls.COLLECTION].find_one(
            {"template_id": template_id, "status": "published"},
            {"_id": 0, "embedding": 0},
        )
        if not raw or raw.get("status") != "published":
            return None
        model = Template(**{**raw, "run_count": _compute_run_count(raw)})
        dumped = model.model_dump(mode="json")
        dumped["is_trending"] = _compute_is_trending(raw)
        if isinstance(raw.get("nodes"), list):
            dumped["nodes"] = raw["nodes"]
        if isinstance(raw.get("edges"), list):
            dumped["edges"] = raw["edges"]
        if raw.get("flow_id"):
            dumped["flow_id"] = raw["flow_id"]
        return dumped

    @classmethod
    async def list_categories(cls, database: Any) -> list[dict[str, Any]]:
        cursor = database[cls.CATEGORIES_COLLECTION].find({}, {"_id": 0})
        to_list = getattr(cursor, "to_list", None)
        if callable(to_list):
            docs = await to_list(length=500)
            if not docs and hasattr(cursor, "docs"):
                docs = list(cursor.docs)
        else:
            docs = list(cursor)
        categories = [dict(d) for d in docs] if docs else [dict(c) for c in DEFAULT_TEMPLATE_CATEGORIES]
        categories.sort(key=lambda item: int(item.get("sort_order") or 0))
        return categories
