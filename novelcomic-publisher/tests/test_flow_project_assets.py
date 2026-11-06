import asyncio
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.schemas.workflow_project import (
    UpdateWorkflowProjectDetailsRequest,
    UpdateWorkflowProjectRequest,
)
from app.services.flow import FlowService
from app.services.media_face_verification import BytePlusAssetInfo, MediaFaceVerificationService

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
)


def _get_nested(document: dict, key: str):
    current = document
    for part in key.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _set_nested(document: dict, key: str, value) -> None:
    current = document
    parts = key.split(".")
    for part in parts[:-1]:
        nested = current.get(part)
        if not isinstance(nested, dict):
            nested = {}
            current[part] = nested
        current = nested
    current[parts[-1]] = value


def _matches(document: dict, query: dict) -> bool:
    for key, value in query.items():
        if key == "$or":
            if not any(_matches(document, branch) for branch in value):
                return False
            continue
        actual = _get_nested(document, key)
        if isinstance(value, dict) and "$in" in value:
            if actual not in value["$in"]:
                return False
            continue
        if actual != value:
            return False
    return True


def _project(document: dict, projection: dict | None) -> dict:
    result = dict(document)
    if not projection:
        return result
    for key, include in projection.items():
        if include == 0:
            result.pop(key, None)
    return result


class FakeCursor:
    def __init__(self, docs: list[dict]) -> None:
        self.docs = docs

    def sort(self, key: str, direction: int) -> "FakeCursor":
        self.docs.sort(key=lambda item: _get_nested(item, key) or 0, reverse=direction < 0)
        return self

    def skip(self, count: int) -> "FakeCursor":
        self.docs = self.docs[count:]
        return self

    def limit(self, count: int) -> "FakeCursor":
        self.docs = self.docs[:count]
        return self

    async def to_list(self, length: int | None = None) -> list[dict]:
        return self.docs[:length] if length is not None else self.docs

    def __aiter__(self):
        self._iter = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeCollection:
    def __init__(self) -> None:
        self.docs: list[dict] = []

    async def insert_one(self, document: dict) -> None:
        self.docs.append(dict(document))

    async def update_one(self, query: dict, update: dict) -> SimpleNamespace:
        modified = 0
        for document in self.docs:
            if not _matches(document, query):
                continue
            for key, value in update.get("$set", {}).items():
                _set_nested(document, key, value)
            modified += 1
        return SimpleNamespace(matched_count=modified, modified_count=modified)

    async def find_one(self, query: dict, projection: dict | None = None) -> dict | None:
        for document in self.docs:
            if _matches(document, query):
                return _project(document, projection)
        return None

    def find(self, query: dict, projection: dict | None = None) -> FakeCursor:
        return FakeCursor(
            [
                _project(document, projection)
                for document in self.docs
                if _matches(document, query)
            ]
        )

    async def count_documents(self, query: dict) -> int:
        return sum(1 for document in self.docs if _matches(document, query))


class FakeDatabase:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {
            "flow_projects": FakeCollection(),
            "asset_library_items": FakeCollection(),
            "node_results": FakeCollection(),
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


class FakeConnections:
    def __init__(self, database: FakeDatabase) -> None:
        self.mongo = FakeMongo(database)

    async def close(self) -> None:
        return None


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    store = FakeDatabase()
    settings = get_settings()
    monkeypatch.setattr(settings, "clerk_pem_public_key", _PUBLIC_PEM)
    monkeypatch.setattr(settings, "mongo_database", "novelcomic")
    monkeypatch.setattr(settings, "cos_bucket", "novelcomic")
    monkeypatch.setattr(settings, "cos_region", "ap-shanghai")
    monkeypatch.setattr(settings, "cos_cdn_domain", "cdn.test")
    monkeypatch.setattr(settings, "cos_accelerate_domain", "accelerate.test")
    monkeypatch.setattr(settings, "s3_domain", "s3.test")
    monkeypatch.setattr(settings, "cloud_front_domain", "cloudfront.test")
    return store


def _client(database: FakeDatabase) -> TestClient:
    app = create_app()
    app.state.connections = FakeConnections(database)
    return TestClient(app)


def _token(sub: str) -> str:
    encoded = jwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
    )
    return encoded if isinstance(encoded, str) else encoded.decode()


def _auth(sub: str = "user_abc") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def test_flow_project_create_read_and_user_isolation(database: FakeDatabase) -> None:
    client = _client(database)

    created = client.post(
        "/api/v2/flow/project",
        headers=_auth(),
        json={
            "project_name": "Untitled",
            "nodes": [{"id": "node-1", "type": "prompt"}],
            "edges": [],
            "allow_reshare": False,
        },
    )

    assert created.status_code == 201
    payload = created.json()
    assert payload["code"] == 200
    assert payload["data"]["flow_id"]
    assert payload["data"]["details"]["project_name"] == "Untitled"
    assert payload["data"]["nodes"] == [{"id": "node-1", "type": "prompt"}]
    assert payload["data"]["allow_reshare"] is False
    assert database["flow_projects"].docs[0]["user_id"] == "user_abc"

    flow_id = payload["data"]["flow_id"]
    found = client.get(f"/api/v2/flow/project/{flow_id}", headers=_auth())
    assert found.status_code == 200
    assert found.json()["data"]["flow_id"] == flow_id
    assert found.json()["data"]["user_id"] is None

    other_user = client.get(f"/api/v2/flow/project/{flow_id}", headers=_auth("user_other"))
    assert other_user.status_code == 404
    assert other_user.json()["msg"] == "Flow project not found"


def _same_instant(stored: datetime, raw: str) -> bool:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    stored_utc = stored if stored.tzinfo is not None else stored.replace(tzinfo=UTC)
    return parsed == stored_utc


async def test_get_workflow_project_writes_last_view_time(database: FakeDatabase) -> None:
    client = _client(database)
    created = client.post(
        "/api/v2/flow/project",
        headers=_auth(),
        json={"project_name": "Untitled", "nodes": [{"id": "node-1"}], "edges": []},
    )
    flow_id = created.json()["data"]["flow_id"]
    own = database["flow_projects"].docs[0]
    assert own["last_view_time"] is None

    sentinel = datetime(2020, 1, 1, tzinfo=UTC)
    database["flow_projects"].docs.append(
        {
            "flow_id": "foreign-flow",
            "user_id": "user_other",
            "last_view_time": sentinel,
            "nodes": [],
            "edges": [],
        }
    )

    missing = client.get("/api/v2/flow/project/does-not-exist", headers=_auth())
    assert missing.status_code == 404
    assert missing.json()["code"] == 1010
    assert own["last_view_time"] is None
    assert database["flow_projects"].docs[1]["last_view_time"] == sentinel

    foreign = client.get("/api/v2/flow/project/foreign-flow", headers=_auth())
    assert foreign.status_code == 404
    assert foreign.json()["code"] == 1010
    assert own["last_view_time"] is None
    assert database["flow_projects"].docs[1]["last_view_time"] == sentinel

    found = client.get(f"/api/v2/flow/project/{flow_id}", headers=_auth())
    assert found.status_code == 200
    viewed_at = own["last_view_time"]
    assert isinstance(viewed_at, datetime)
    assert viewed_at.utcoffset() == timedelta(0)
    assert _same_instant(viewed_at, found.json()["data"]["last_view_time"])
    assert database["flow_projects"].docs[1]["last_view_time"] == sentinel

    await FlowService.update_workflow_project_without_response(
        database=database,
        req=UpdateWorkflowProjectRequest(
            flow_id=flow_id,
            nodes=[{"id": "node-2"}],
            edges=[],
        ),
        user_id="user_abc",
    )
    await FlowService.update_workflow_project_details_without_response(
        database=database,
        req=UpdateWorkflowProjectDetailsRequest(flow_id=flow_id, project_name="Renamed"),
        user_id="user_abc",
    )
    assert own["last_view_time"] == viewed_at
    assert own["nodes"] == [{"id": "node-2"}]
    assert own["details"]["project_name"] == "Renamed"


async def test_patch_flow_project_updates_current_user_without_updated_at(
    database: FakeDatabase,
) -> None:
    app = create_app()
    app.state.connections = FakeConnections(database)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v2/flow/project",
            headers=_auth(),
            json={
                "project_name": "Untitled",
                "nodes": [{"id": "node-1", "type": "textInput"}],
                "edges": [],
            },
        )
        flow_id = created.json()["data"]["flow_id"]
        original_name = database["flow_projects"].docs[0]["details"]["project_name"]
        original_updated_at = database["flow_projects"].docs[0]["updated_at"]

        patched = await client.patch(
            "/api/v2/flow/project",
            headers=_auth(),
            json={
                "flow_id": flow_id,
                "nodes": [{"id": "node-2", "type": "imageInput", "data": {"inputText": "kept"}}],
                "edges": [{"id": "edge-1", "source": "node-2", "target": "node-2"}],
            },
        )

        assert patched.status_code == 200
        assert patched.json() == {"code": 200, "msg": "ok", "data": {}}
        assert "updated_at" not in patched.json()["data"]

        await asyncio.sleep(0)

        document = database["flow_projects"].docs[0]
        assert document["user_id"] == "user_abc"
        assert document["nodes"][0]["id"] == "node-2"
        assert document["edges"] == [{"id": "edge-1", "source": "node-2", "target": "node-2"}]
        assert document["details"]["project_name"] == original_name
        assert document["updated_at"] > original_updated_at
        assert document["details"]["updated_at"] > original_updated_at

        found = await client.get(f"/api/v2/flow/project/{flow_id}", headers=_auth())
        assert found.status_code == 200
        assert found.json()["data"]["nodes"][0]["id"] == "node-2"

        other_user = await client.patch(
            "/api/v2/flow/project",
            headers=_auth("user_other"),
            json={
                "flow_id": flow_id,
                "nodes": [{"id": "stolen", "type": "textInput"}],
                "edges": [],
            },
        )
        assert other_user.status_code == 200
        await asyncio.sleep(0)
        assert database["flow_projects"].docs[0]["nodes"][0]["id"] == "node-2"


async def test_patch_flow_project_details_updates_cover_without_nodes(
    database: FakeDatabase,
) -> None:
    app = create_app()
    app.state.connections = FakeConnections(database)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v2/flow/project",
            headers=_auth(),
            json={"project_name": "Untitled", "nodes": [{"id": "node-1"}], "edges": []},
        )
        flow_id = created.json()["data"]["flow_id"]
        patched = await client.patch(
            "/api/v2/flow/project/details",
            headers=_auth(),
            json={
                "flow_id": flow_id,
                "snapshot_url": "https://cdn.test/cover.png",
                "snapshot_thumbnail_url": "https://cdn.test/cover-small.png",
            },
        )
        assert patched.status_code == 200
        await asyncio.sleep(0)
        document = database["flow_projects"].docs[0]
        assert document["nodes"] == [{"id": "node-1"}]
        assert document["details"]["snapshot"]["snapshot_url"] == "https://cdn.test/cover.png"
        other_user = await client.patch(
            "/api/v2/flow/project/details",
            headers=_auth("user_other"),
            json={"flow_id": flow_id, "project_name": "Stolen"},
        )
        assert other_user.status_code == 200
        await asyncio.sleep(0)
        assert document["details"]["project_name"] == "Untitled"


def test_patch_flow_project_requires_auth(database: FakeDatabase) -> None:
    client = _client(database)

    response = client.patch(
        "/api/v2/flow/project",
        json={"flow_id": "missing", "nodes": [], "edges": []},
    )

    assert response.status_code == 401
    assert response.json()["msg"] == "Authorization field is required"


def test_flow_project_requires_auth(database: FakeDatabase) -> None:
    client = _client(database)

    response = client.post(
        "/api/v2/flow/project",
        json={"project_name": "Untitled", "nodes": [], "edges": []},
    )

    assert response.status_code == 401
    assert response.json()["msg"] == "Authorization field is required"


def test_cos_presign_returns_upload_target_without_auth(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_presign(*, object_key: str, content_type: str, expires_in: int = 3600) -> str:
        assert object_key.startswith("images/")
        assert object_key.endswith(".png")
        assert content_type == "image/png"
        assert expires_in == 3600
        return f"https://upload.test/{object_key}"

    monkeypatch.setattr("app.controller.v2.cos.a_generate_cos_presigned_put_url", fake_presign)
    client = _client(database)

    response = client.post(
        "/api/v2/cos/presign",
        json={"filename": "role.png", "content_type": "image/png", "file_type": "image"},
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["presigned_url"].startswith("https://upload.test/images/")
    assert payload["object_key"].startswith("images/")
    assert payload["object_key"].endswith(".png")
    assert payload["cdn_url"] == f"https://cdn.test/{payload['object_key']}"
    assert payload["expires_in"] == 3600


def test_asset_library_create_and_dedupe_uploaded_asset(database: FakeDatabase) -> None:
    client = _client(database)
    request_body = {
        "library_kind": "character",
        "source_kind": "uploaded",
        "media_type": "image",
        "url": "https://cdn.test/role.png",
        "thumbnail_url": "https://cdn.test/role-thumb.png",
        "name": "role.png",
        "upload_context": "home_composer_attach",
        "resource_info": {
            "width": 1024,
            "height": 1024,
            "format": "png",
            "file_size": 2048,
        },
        "aspect_ratio": "1024:1024",
    }

    created = client.post("/api/v3/assets/library", headers=_auth(), json=request_body)

    assert created.status_code == 200
    data = created.json()["data"]
    assert data["asset_id"]
    assert data["library_kind"] == "character"
    assert data["source_kind"] == "uploaded"
    assert data["media_type"] == "image"
    assert data["url"] == "https://cdn.test/role.png"
    assert data["upload_context"] == "home_composer_attach"
    assert data["metadata"] == {
        "resource_info": {
            "width": 1024,
            "height": 1024,
            "format": "png",
            "file_size": 2048,
        },
        "aspect_ratio": "1024/1024",
    }
    assert database["asset_library_items"].docs[0]["user_id"] == "user_abc"

    duplicate = client.post("/api/v3/assets/library", headers=_auth(), json=request_body)
    assert duplicate.status_code == 200
    assert duplicate.json()["data"]["asset_id"] == data["asset_id"]
    assert len(database["asset_library_items"].docs) == 1


def test_asset_library_dedupe_is_scoped_by_user_and_kind(database: FakeDatabase) -> None:
    client = _client(database)
    request_body = {
        "library_kind": "product",
        "source_kind": "uploaded",
        "media_type": "video",
        "url": "https://cdn.test/shared.mp4",
    }

    user_a = client.post("/api/v3/assets/library", headers=_auth("user_a"), json=request_body)
    user_b = client.post("/api/v3/assets/library", headers=_auth("user_b"), json=request_body)

    assert user_a.status_code == 200
    assert user_b.status_code == 200
    assert user_a.json()["data"]["asset_id"] != user_b.json()["data"]["asset_id"]
    assert len(database["asset_library_items"].docs) == 2


def test_asset_library_rejects_foreign_media_url(database: FakeDatabase) -> None:
    client = _client(database)

    response = client.post(
        "/api/v3/assets/library",
        headers=_auth(),
        json={
            "library_kind": "character",
            "source_kind": "uploaded",
            "media_type": "image",
            "url": "https://evil.test/role.png",
        },
    )

    assert response.status_code == 400
    assert response.json()["msg"] == "url must point to the configured NovelComic media CDN"
    assert database["asset_library_items"].docs == []


def test_asset_library_fetch_uploaded_filters_current_user_and_kind(
    database: FakeDatabase,
) -> None:
    now = datetime.now(UTC)
    database["asset_library_items"].docs.extend(
        [
            {
                "asset_id": "asset-1",
                "user_id": "user_abc",
                "library_kind": "character",
                "source_kind": "uploaded",
                "media_type": "image",
                "url": "https://cdn.test/role.png",
                "thumbnail_url": "",
                "name": "role.png",
                "upload_context": "home_composer_attach",
                "metadata": {"resource_info": {"width": 100, "height": 200}},
                "created_at": now,
                "updated_at": now,
            },
            {
                "asset_id": "asset-2",
                "user_id": "user_other",
                "library_kind": "character",
                "source_kind": "uploaded",
                "media_type": "image",
                "url": "https://cdn.test/other.png",
                "created_at": now,
                "updated_at": now,
            },
        ],
    )
    client = _client(database)

    response = client.post(
        "/api/v3/assets/fetch?category=image",
        headers=_auth(),
        json={"source_kind": "uploaded", "library_kind": "character"},
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["meta"]["total_count"] == 1
    assert payload["output"][0]["result"] == "https://cdn.test/role.png"
    assert payload["output"][0]["metadata"]["source_kind"] == "uploaded"


def test_asset_library_sink_generated_requires_existing_user_result(
    database: FakeDatabase,
) -> None:
    now = datetime.now(UTC)
    database["node_results"].docs.append(
        {
            "result_id": "result-1",
            "user_id": "user_abc",
            "type": "image",
            "result": "https://cdn.test/generated.png",
            "metadata": {},
            "created_at": now,
            "updated_at": now,
        }
    )
    client = _client(database)

    sunk = client.post(
        "/api/v3/assets/library/sink",
        headers=_auth(),
        json={
            "items": [
                {
                    "library_kind": "brand_visual",
                    "media_type": "image",
                    "url": "https://cdn.test/generated.png",
                    "result_id": "result-1",
                    "resource_info": {"width": 1280, "height": 720},
                }
            ]
        },
    )

    assert sunk.status_code == 200
    assert sunk.json()["data"]["sunk_count"] == 1
    metadata = database["node_results"].docs[0]["metadata"]
    assert metadata["source_kind"] == "generated"
    assert metadata["library_kind"] == "brand_visual"
    assert metadata["output_cdn_url"] == "https://cdn.test/generated.png"
    assert metadata["aspect_ratio"] == "16/9"

    missing = client.post(
        "/api/v3/assets/library/sink",
        headers=_auth("user_other"),
        json={
            "items": [
                {
                    "library_kind": "brand_visual",
                    "media_type": "image",
                    "url": "https://cdn.test/generated.png",
                    "result_id": "result-1",
                }
            ]
        },
    )

    assert missing.status_code == 404


def test_asset_library_sink_rejects_mismatched_generated_url(database: FakeDatabase) -> None:
    now = datetime.now(UTC)
    database["node_results"].docs.append(
        {
            "result_id": "result-2",
            "user_id": "user_abc",
            "type": "image",
            "result": "https://cdn.test/generated.png",
            "metadata": {},
            "created_at": now,
            "updated_at": now,
        }
    )
    client = _client(database)

    response = client.post(
        "/api/v3/assets/library/sink",
        headers=_auth(),
        json={
            "items": [
                {
                    "library_kind": "product",
                    "media_type": "image",
                    "url": "https://cdn.test/fresh-upload.png",
                    "result_id": "result-2",
                }
            ]
        },
    )

    assert response.status_code == 400
    assert response.json()["msg"] == "url does not belong to the selected generated result"


def test_media_face_verification_ingest_is_idempotent_and_fetches_status(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_create_asset(*, url: str, media_type: str) -> BytePlusAssetInfo:
        assert url == "https://cdn.test/role.png"
        assert media_type == "image"
        return BytePlusAssetInfo(asset_id="asset-1")

    enqueued: list[dict[str, str]] = []

    async def fake_enqueue(*, media_url: str, asset_id: str) -> None:
        enqueued.append({"media_url": media_url, "asset_id": asset_id})

    monkeypatch.setattr(
        MediaFaceVerificationService,
        "_create_byteplus_asset",
        staticmethod(fake_create_asset),
    )
    monkeypatch.setattr(
        MediaFaceVerificationService,
        "_enqueue_ai_verification",
        staticmethod(fake_enqueue),
    )
    client = _client(database)

    first = client.post(
        "/api/v3/media-face-verifications/ingest",
        headers=_auth(),
        json={"url": "https://cdn.test/role.png", "type": "image", "content_hash": "hash-1"},
    )
    second = client.post(
        "/api/v3/media-face-verifications/ingest",
        headers=_auth(),
        json={"url": "https://cdn.test/role.png", "type": "image", "content_hash": "hash-1"},
    )
    status = client.post(
        "/api/v3/media-face-verifications/status",
        headers=_auth(),
        json={"urls": ["https://cdn.test/role.png", "https://cdn.test/missing.png"]},
    )

    assert first.status_code == 200
    assert first.json()["data"] == {
        "status": "processing",
        "is_new": True,
        "reused_from_content_hash": False,
    }
    assert second.status_code == 200
    assert second.json()["data"]["is_new"] is False
    assert second.json()["data"]["status"] == "processing"
    assert enqueued == [{"media_url": "https://cdn.test/role.png", "asset_id": "asset-1"}]
    assert database["node_results"].docs == []
    assert status.json()["data"]["items"][0]["status"] == "processing"
    assert status.json()["data"]["items"][1]["status"] == "not_found"


def test_media_face_verification_reuses_active_content_hash(database: FakeDatabase) -> None:
    now = datetime.now(UTC)
    database["media_face_verifications"].docs.append(
        {
            "verification_id": "verification-existing",
            "user_id": "user_other",
            "media": {
                "id": "media-existing",
                "url": "https://cdn.test/existing.png",
                "type": "image",
                "content_hash": "same-hash",
            },
            "face_providers": {
                "byteplus": {
                    "asset_id": "asset-active",
                    "verification_status": "active",
                    "sync_status": "synced",
                }
            },
            "created_at": now,
            "updated_at": now,
        }
    )
    client = _client(database)

    response = client.post(
        "/api/v3/media-face-verifications/ingest",
        headers=_auth(),
        json={"url": "https://cdn.test/new.png", "type": "image", "content_hash": "same-hash"},
    )

    assert response.status_code == 200
    assert response.json()["data"] == {
        "status": "active",
        "is_new": True,
        "reused_from_content_hash": True,
    }
    state = database["media_face_verifications"].docs[-1]["face_providers"]["byteplus"]
    assert state["asset_id"] == "asset-active"


def test_media_face_verification_retries_failed_without_asset_id(
    database: FakeDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    database["media_face_verifications"].docs.append(
        {
            "verification_id": "verification-failed",
            "user_id": "user_abc",
            "media": {
                "id": "media-failed",
                "url": "https://cdn.test/retry.png",
                "type": "image",
                "content_hash": None,
            },
            "face_providers": {
                "byteplus": {
                    "verification_status": "failed",
                    "sync_status": "failed",
                }
            },
            "created_at": now,
            "updated_at": now,
        }
    )

    async def fake_create_asset(*, url: str, media_type: str) -> BytePlusAssetInfo:
        assert url == "https://cdn.test/retry.png"
        assert media_type == "video"
        return BytePlusAssetInfo(asset_id="asset-retry")

    async def fake_enqueue(*, media_url: str, asset_id: str) -> None:
        return None

    monkeypatch.setattr(
        MediaFaceVerificationService,
        "_create_byteplus_asset",
        staticmethod(fake_create_asset),
    )
    monkeypatch.setattr(
        MediaFaceVerificationService,
        "_enqueue_ai_verification",
        staticmethod(fake_enqueue),
    )
    client = _client(database)

    response = client.post(
        "/api/v3/media-face-verifications/ingest",
        headers=_auth(),
        json={"url": "https://cdn.test/retry.png", "type": "video"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["is_new"] is False
    assert response.json()["data"]["status"] == "processing"
    state = database["media_face_verifications"].docs[0]["face_providers"]["byteplus"]
    assert state["asset_id"] == "asset-retry"
    assert state["verification_status"] == "processing"
