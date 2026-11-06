from datetime import datetime

from app.schemas.template import Template


def test_template_entity_defaults_match_marketplace_contract() -> None:
    template = Template(template_id="template-1")

    assert template.name == {}
    assert template.desc == {}
    assert template.tags == []
    assert template.models == []
    assert template.categories == []
    assert template.covers == []
    assert template.videos == []
    assert template.share_id is None
    assert template.origin_flow_id is None
    assert template.workflow_stages == []
    assert template.workflow_io is None
    assert template.estimated_credits == 0
    assert template.is_hot is False
    assert template.is_recommend is False
    assert template.run_count == 0
    assert template.stats_boost.model_dump() == {
        "created_count": 0,
        "user_count": 0,
        "acquired_user_count": 0,
        "run_count": 0,
        "total_credits": 0,
    }
    assert template.status == "draft"


def test_template_keeps_share_origin_flow_and_stats_boost() -> None:
    template = Template(
        template_id="template-published",
        share_id="share-1",
        origin_flow_id="flow-1",
        status="published",
        run_count=12,
        stats_boost={"run_count": 5, "total_credits": 200},
    )

    assert template.share_id == "share-1"
    assert template.origin_flow_id == "flow-1"
    assert template.status == "published"
    assert template.run_count == 12
    assert template.stats_boost.model_dump() == {
        "created_count": 0,
        "user_count": 0,
        "acquired_user_count": 0,
        "run_count": 5,
        "total_credits": 200,
    }


def test_template_normalizes_workflow_io_string_items() -> None:
    template = Template(
        template_id="template-workflow",
        workflow_io={
            "inputs": ["image", {"type": "prompt", "label": "Prompt"}],
            "outputs": ["video"],
        },
    )

    assert template.workflow_io is not None
    assert [item.model_dump() for item in template.workflow_io.inputs] == [
        {"type": "image", "label": "image"},
        {"type": "prompt", "label": "Prompt"},
    ]
    assert [item.model_dump() for item in template.workflow_io.outputs] == [
        {"type": "video", "label": "video"}
    ]


def test_template_serializes_datetimes_like_opencreator() -> None:
    template = Template(template_id="template-date", published_at=datetime(2026, 9, 28, 13, 14, 0))

    assert '"published_at":"2026-09-28 13:14:00"' in template.model_dump_json()


def test_public_template_routes_allow_anonymous_access_and_filter_published() -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services.template import TemplateService
    from tests.test_local_user import FakeConnections, FakeDatabase

    TemplateService.clear_cache()
    db = FakeDatabase()
    db["templates"].docs.extend(
        [
            {
                "template_id": "tpl-pub-1",
                "name": {"zh": "玄幻开场", "en": "Fantasy Intro"},
                "desc": {"zh": "测试模板", "en": "Test template"},
                "categories": ["comic-production"],
                "status": "published",
                "is_recommend": True,
                "run_count": 20,
                "stats_daily": [
                    {"date": "2026-09-22", "run_count": 10},
                    {"date": "2026-09-28", "run_count": 18},
                ],
            },
            {
                "template_id": "tpl-draft-1",
                "name": {"zh": "草稿模板"},
                "status": "draft",
            },
        ]
    )
    app = create_app()
    app.state.connections = FakeConnections(db)
    client = TestClient(app)

    page_resp = client.get("/api/v1/templates/page?page_number=1&page_size=20")
    assert page_resp.status_code == 200
    page_data = page_resp.json()["data"]
    assert page_data["total"] == 1
    assert page_data["recommend_count"] == 1
    assert page_data["items"][0]["template_id"] == "tpl-pub-1"
    assert page_data["items"][0]["is_trending"] is True

    cat_resp = client.get("/api/v1/templates/categories/list")
    assert cat_resp.status_code == 200
    categories = cat_resp.json()["data"]
    assert len(categories) >= 1

    detail_resp = client.get("/api/v1/templates/tpl-pub-1")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["data"]["template_id"] == "tpl-pub-1"

    draft_resp = client.get("/api/v1/templates/tpl-draft-1")
    assert draft_resp.status_code == 404

