from pathlib import Path

from novelcomic_agent.config import Settings, agent_reply_queue_name


def test_settings_load_dot_env_local(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text(
        "APP_PORT=19999\nMONGODB_DATABASE=test_database\n",
        encoding="utf-8",
    )

    settings = Settings()

    assert settings.app_port == 19999
    assert settings.mongodb_database == "test_database"


def test_blue_and_green_reply_queues_differ() -> None:
    blue = Settings(workflow_deploy_id="agent-prod-blue")
    green = Settings(workflow_deploy_id="agent-prod-green")

    assert blue.reply_queue_name == "flow_result.agent-prod-blue"
    assert green.reply_queue_name == "flow_result.agent-prod-green"
    assert blue.reply_queue_name != green.reply_queue_name
    assert agent_reply_queue_name(" agent-prod-blue ") == blue.reply_queue_name


def test_missing_deploy_id_has_no_reply_queue(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("WORKFLOW_DEPLOY_ID", raising=False)
    monkeypatch.delenv("CREATO_WORKFLOW__DEPLOY_ID", raising=False)

    assert Settings().workflow_deploy_id == ""
    assert Settings().reply_queue_name == ""


def test_deploy_id_comes_from_workflow_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("CREATO_WORKFLOW__DEPLOY_ID", raising=False)
    monkeypatch.setenv("WORKFLOW_DEPLOY_ID", "agent-prod-blue")

    settings = Settings()

    assert settings.workflow_deploy_id == "agent-prod-blue"
    assert settings.reply_queue_name == agent_reply_queue_name("agent-prod-blue")


def test_deploy_id_comes_from_creato_workflow_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("WORKFLOW_DEPLOY_ID", raising=False)
    monkeypatch.setenv("CREATO_WORKFLOW__DEPLOY_ID", "agent-prod-green")

    settings = Settings()

    assert settings.workflow_deploy_id == "agent-prod-green"
    assert settings.reply_queue_name == "flow_result.agent-prod-green"
