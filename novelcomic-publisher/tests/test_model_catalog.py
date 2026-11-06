import base64
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.schemas.model_dropdown_order import DROPDOWN_GROUP_NAMES
from app.schemas.request_schemas.model_dropdown_order_request import ModelSortItemRequest
from app.services.model_dropdown_order import ModelDropdownOrderService
from app.utils.model_dropdown_order import build_dropdown_order, default_brand_order


def _get_nested(document: dict[str, Any], key: str) -> Any:
    current: Any = document
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_nested(document: dict[str, Any], key: str, value: Any) -> None:
    current = document
    parts = key.split(".")
    for part in parts[:-1]:
        nested = current.get(part)
        if not isinstance(nested, dict):
            nested = {}
            current[part] = nested
        current = nested
    current[parts[-1]] = value


def _matches(document: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, value in query.items():
        if _get_nested(document, key) != value:
            return False
    return True


def _project(document: dict[str, Any], projection: dict[str, int] | None) -> dict[str, Any]:
    result = dict(document)
    if not projection:
        return result
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


class FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        return self.docs[:length] if length is not None else self.docs

    def __aiter__(self) -> "FakeCursor":
        self._iter = iter(self.docs)
        return self

    async def __anext__(self) -> dict[str, Any]:
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    async def insert_one(self, document: dict[str, Any]) -> None:
        self.docs.append(dict(document))

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        upsert: bool = False,
    ) -> SimpleNamespace:
        for document in self.docs:
            if not _matches(document, query):
                continue
            for key, value in update.get("$set", {}).items():
                _set_nested(document, key, value)
            for key in update.get("$unset", {}):
                document.pop(key, None)
            return SimpleNamespace(matched_count=1, modified_count=1)

        if upsert:
            document = dict(query)
            for key, value in update.get("$set", {}).items():
                _set_nested(document, key, value)
            self.docs.append(document)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def delete_one(self, query: dict[str, Any]) -> SimpleNamespace:
        before = len(self.docs)
        self.docs = [document for document in self.docs if not _matches(document, query)]
        return SimpleNamespace(deleted_count=before - len(self.docs))

    async def find_one(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> dict[str, Any] | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None

    def find(
        self,
        query: dict[str, Any],
        projection: dict[str, int] | None = None,
    ) -> FakeCursor:
        return FakeCursor(
            [_project(document, projection) for document in self.docs if _matches(document, query)]
        )


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "model_configs": FakeCollection(),
            "model_sort_configs": FakeCollection(),
        }

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection()
        return self.collections[name]


class FakeMongo:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database

    def __getitem__(self, name: str) -> FakeDatabase:
        return self._database


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.writes = 0

    async def set(self, key: str, value: str) -> None:
        self.values[key] = value
        self.writes += 1

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)
        self.writes += 1


class FakeConnections:
    def __init__(self, database: FakeDatabase, redis: FakeRedis) -> None:
        self.mongo = FakeMongo(database)
        self.redis = redis

    async def close(self) -> None:
        return None


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    monkeypatch.setattr(get_settings(), "mongo_database", "novelcomic")
    return FakeDatabase()


@pytest.fixture
def redis_client() -> FakeRedis:
    return FakeRedis()


def _internal_headers(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    monkeypatch.setattr(get_settings(), "internal_api_key", "internal-secret")
    encoded = base64.b64encode(b"internal-secret").decode("ascii")
    return {"Authorization": encoded}


def _client(database: FakeDatabase, redis_client: FakeRedis) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database, redis_client)
    return TestClient(app)


def test_dropdown_order_returns_all_six_groups_with_stable_sorting() -> None:
    data = build_dropdown_order(
        brand_order=default_brand_order(),
        model_docs=[
            {
                "config_name": "text_to_video_config",
                "model_id": "kling/new",
                "display_name": "Kling New",
                "brand": "kling",
                "released_at": "2026-01-01",
            },
            {
                "config_name": "text_to_video_config",
                "model_id": "seedance/old",
                "display_name": "Seedance Old",
                "brand": "seedance",
                "released_at": "2025-01-01",
            },
        ],
        group="all",
    )

    assert tuple(data.groups) == DROPDOWN_GROUP_NAMES
    assert [item.model_id for item in data.groups["text_to_video"].models] == [
        "seedance/old",
        "kling/new",
    ]


def test_public_models_reject_unknown_dropdown_group(
    database: FakeDatabase,
    redis_client: FakeRedis,
) -> None:
    response = _client(database, redis_client).get("/api/v1/models/dropdown-order?group=bad")

    assert response.status_code == 400
    assert response.json()["code"] == 1003


def test_internal_model_config_requires_the_service_key(
    database: FakeDatabase,
    redis_client: FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(database, redis_client)
    monkeypatch.setattr(get_settings(), "internal_api_key", "")
    unconfigured = client.get("/api/internal/model-config/list?config_name=all")
    monkeypatch.setattr(get_settings(), "internal_api_key", "internal-secret")
    missing = client.get("/api/internal/model-config/list?config_name=all")
    jwt = client.get(
        "/api/internal/model-config/list?config_name=all",
        headers={"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"},
    )
    wrong = client.get(
        "/api/internal/model-config/list?config_name=all",
        headers={"Authorization": base64.b64encode(b"wrong-secret").decode("ascii")},
    )

    assert unconfigured.status_code == 503
    assert unconfigured.json()["msg"] == "internal API is not configured"
    assert missing.status_code == 401
    assert jwt.status_code == 401
    assert wrong.status_code == 401
    assert wrong.json()["msg"] == "invalid authorization value for internal endpoint"


def test_internal_upsert_refreshes_cache_and_public_list_reads_new_document(
    database: FakeDatabase,
    redis_client: FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(database, redis_client)

    created = client.post(
        "/api/internal/model-config/upsert",
        headers=_internal_headers(monkeypatch),
        json={
            "config_name": "text_to_image_config",
            "model_id": "gpt-image-1",
            "display_name": "GPT Image",
            "pricing": {"credits": 10},
            "params": {"size": "1024x1024"},
        },
    )
    listed = client.get("/api/v1/models/list?config_name=all")

    assert created.status_code == 200
    assert listed.status_code == 200
    assert listed.json()["data"][0]["model_id"] == "gpt-image-1"
    assert "model_config:text_to_image_config" in redis_client.values
    assert "model_config:__all__" in redis_client.values


async def test_sort_update_does_not_touch_pricing_or_refresh_redis(
    database: FakeDatabase,
    redis_client: FakeRedis,
) -> None:
    database["model_configs"].docs.append(
        {
            "config_name": "text_to_video_config",
            "model_id": "seedance/pro",
            "display_name": "Seedance Pro",
            "pricing": {"credits": 12},
            "params": {"duration": 5},
        }
    )

    result = await ModelDropdownOrderService.batch_update_models(
        database,
        [
            ModelSortItemRequest(
                config_name="text_to_video_config",
                model_id="seedance/pro",
                brand="Seedance",
                released_at="2026-02-03",
                sort_in_brand=2,
                dropdown_groups=["text_to_video"],
            )
        ],
    )

    doc = database["model_configs"].docs[0]
    assert result["updated"] == [
        {"config_name": "text_to_video_config", "model_id": "seedance/pro"}
    ]
    assert doc["pricing"] == {"credits": 12}
    assert doc["brand"] == "seedance"
    assert doc["released_at"] == "2026-02-03"
    assert redis_client.writes == 0
