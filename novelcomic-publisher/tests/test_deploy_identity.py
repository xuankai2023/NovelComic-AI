import re

from app.config import (
    Settings,
    get_settings,
    instance_reply_queue_name,
    resolve_settings_env_file,
    v2_result_queue_name,
)
from app.database.mq import (
    INSTANCE_REPLY_QUEUE_NAME,
    V2_REPLY_QUEUE_NAME,
    declared_result_queue_names,
)
from app.services.workflow_runs_v2 import V2_REPLY_QUEUE_NAME as SERVICE_V2_REPLY_QUEUE_NAME


def test_missing_app_env_reads_dotenv_local(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("PUBLISHER_DEPLOY_ID", raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text("PUBLISHER_DEPLOY_ID=from-local\n", encoding="utf-8")
    (tmp_path / ".env.prod").write_text("PUBLISHER_DEPLOY_ID=from-prod\n", encoding="utf-8")

    settings = Settings()

    assert resolve_settings_env_file() == ".env.local"
    assert settings.publisher_deploy_id == "from-local"
    assert settings.app_env == "local"
    assert settings.v2_reply_queue == "flow_result.workflow.v2.local"


def test_app_env_selects_matching_env_file(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("PUBLISHER_DEPLOY_ID", raising=False)
    monkeypatch.setenv("APP_ENV", "prod")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text("PUBLISHER_DEPLOY_ID=from-local\n", encoding="utf-8")
    (tmp_path / ".env.prod").write_text(
        "PUBLISHER_DEPLOY_ID=from-prod\nAPP_ENV=prod\n",
        encoding="utf-8",
    )

    settings = Settings()

    assert resolve_settings_env_file() == ".env.prod"
    assert settings.publisher_deploy_id == "from-prod"
    assert settings.app_env == "prod"
    assert settings.instance_reply_queue == "flow_result.from-prod"
    assert settings.v2_reply_queue == "flow_result.workflow.v2.prod"


def test_unit_file_deploy_id_overrides_env_file(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("PUBLISHER_DEPLOY_ID", "blue")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text("PUBLISHER_DEPLOY_ID=from-file\n", encoding="utf-8")

    settings = Settings()

    assert settings.publisher_deploy_id == "blue"
    assert settings.instance_reply_queue == "flow_result.blue"


def test_missing_deploy_id_is_stable_pub_hex(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("PUBLISHER_DEPLOY_ID", raising=False)
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    assert re.fullmatch(r"pub-[0-9a-f]{8}", settings.publisher_deploy_id)
    assert settings.instance_reply_queue == instance_reply_queue_name(settings.publisher_deploy_id)


def test_blue_and_green_share_v2_queue_and_split_instance_queues() -> None:
    blue = Settings(app_env="prod", publisher_deploy_id="blue", flow_v2_result_queue_name="")
    green = Settings(app_env="prod", publisher_deploy_id="green", flow_v2_result_queue_name="")

    assert blue.instance_reply_queue == "flow_result.blue"
    assert green.instance_reply_queue == "flow_result.green"
    assert blue.v2_reply_queue == green.v2_reply_queue == "flow_result.workflow.v2.prod"
    assert blue.v2_reply_queue == v2_result_queue_name("prod")


def test_flow_v2_result_queue_name_overrides_app_env_suffix() -> None:
    settings = Settings(
        app_env="prod",
        publisher_deploy_id="blue",
        flow_v2_result_queue_name=" flow_result.explicit ",
    )

    assert settings.v2_reply_queue == "flow_result.explicit"
    assert settings.instance_reply_queue == "flow_result.blue"


def test_imported_queue_names_follow_process_settings() -> None:
    settings = get_settings()

    assert SERVICE_V2_REPLY_QUEUE_NAME == V2_REPLY_QUEUE_NAME
    assert INSTANCE_REPLY_QUEUE_NAME == instance_reply_queue_name(settings.publisher_deploy_id)
    assert V2_REPLY_QUEUE_NAME == v2_result_queue_name(
        settings.app_env,
        settings.flow_v2_result_queue_name,
    )
    assert declared_result_queue_names() == (INSTANCE_REPLY_QUEUE_NAME, V2_REPLY_QUEUE_NAME)
