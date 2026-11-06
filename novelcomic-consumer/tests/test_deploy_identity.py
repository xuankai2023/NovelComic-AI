from app.config import Settings, get_settings, resolve_settings_env_file, v2_result_queue_name
from app.database.mq import V2_REPLY_QUEUE_NAME
from app.tasks.flow import FlowStreamWorker, RunFlowStream


def test_two_consumers_share_queue_names_and_keep_distinct_ids() -> None:
    blue = Settings(app_env="prod", consumer_instance_id="blue")
    green = Settings(app_env="prod", consumer_instance_id="green")

    assert blue.run_flow_queue_name == green.run_flow_queue_name == "run_flow"
    assert blue.flow_resume_queue_name == green.flow_resume_queue_name == "flow_resume"
    assert (
        blue.flow_maintenance_queue_name == green.flow_maintenance_queue_name == "flow_maintenance"
    )
    assert blue.consumer_instance_id == "blue"
    assert green.consumer_instance_id == "green"
    assert blue.v2_reply_queue == green.v2_reply_queue == "flow_result.workflow.v2.prod"


def test_queue_name_override_and_blank_fallback() -> None:
    custom = Settings(
        app_env="prod",
        run_flow_queue_name=" shared_run_flow ",
        flow_resume_queue_name="",
        flow_maintenance_queue_name="   ",
        flow_v2_result_queue_name=" flow_result.explicit ",
        consumer_instance_id="blue",
    )

    assert custom.run_flow_queue_name == "shared_run_flow"
    assert custom.flow_resume_queue_name == "flow_resume"
    assert custom.flow_maintenance_queue_name == "flow_maintenance"
    assert custom.v2_reply_queue == "flow_result.explicit"
    assert custom.v2_reply_queue == v2_result_queue_name("prod", "flow_result.explicit")


def test_app_env_selects_consumer_env_file(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("RUN_FLOW_QUEUE_NAME", raising=False)
    monkeypatch.delenv("CONSUMER_INSTANCE_ID", raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text(
        "RUN_FLOW_QUEUE_NAME=from-local\nCONSUMER_INSTANCE_ID=local-id\n",
        encoding="utf-8",
    )
    (tmp_path / ".env.prod").write_text(
        "RUN_FLOW_QUEUE_NAME=from-prod\nCONSUMER_INSTANCE_ID=prod-id\n",
        encoding="utf-8",
    )

    assert resolve_settings_env_file() == ".env.local"
    local = Settings()
    assert local.run_flow_queue_name == "from-local"
    assert local.consumer_instance_id == "local-id"

    monkeypatch.setenv("APP_ENV", "prod")
    assert resolve_settings_env_file() == ".env.prod"
    prod = Settings()
    assert prod.run_flow_queue_name == "from-prod"
    assert prod.consumer_instance_id == "prod-id"
    assert prod.v2_reply_queue == "flow_result.workflow.v2.prod"


def test_unit_instance_id_overrides_env_file(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("CONSUMER_INSTANCE_ID", "green")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text("CONSUMER_INSTANCE_ID=from-file\n", encoding="utf-8")

    assert Settings().consumer_instance_id == "green"


def test_imported_v2_queue_follows_process_settings() -> None:
    settings = get_settings()
    assert V2_REPLY_QUEUE_NAME == v2_result_queue_name(
        settings.app_env,
        settings.flow_v2_result_queue_name,
    )


class _FakeRedis:
    def __init__(self) -> None:
        self.messages: list[tuple[str, dict[str, str]]] = []

    async def xadd(self, queue_name: str, message: dict[str, str]) -> str:
        self.messages.append((queue_name, dict(message)))
        return "1-0"


async def test_run_flow_publish_uses_configured_queue_name(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "run_flow_queue_name", "shared_run_flow")
    redis = _FakeRedis()

    message_id = await RunFlowStream.aio_push(redis, flow_task_id="task-1")

    assert message_id == "1-0"
    assert redis.messages[0][0] == "shared_run_flow"
    worker = FlowStreamWorker(database=None, redis_client=None, publisher=None)
    assert worker.stream == "shared_run_flow"
