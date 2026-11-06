from fastapi.testclient import TestClient

from app.legacy import legacy_call_volume, note_v1_flow_path, reset_legacy_call_volume
from app.main import create_app


def test_v1_flow_path_is_counted_and_other_paths_are_not() -> None:
    reset_legacy_call_volume()
    note_v1_flow_path("/api/v1/flow/flow_task/ws-1")
    note_v1_flow_path("/api/v1/flow")
    note_v1_flow_path("/api/v2/flow/runs")
    assert legacy_call_volume() == {"v1_flow": 2}


def test_v1_flow_request_counts_before_jwt_rejection() -> None:
    reset_legacy_call_volume()
    response = TestClient(create_app()).get("/api/v1/flow/flow_task/ws-1")
    assert response.status_code == 401
    assert legacy_call_volume()["v1_flow"] == 1
