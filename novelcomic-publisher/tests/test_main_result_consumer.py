"""主进程结果消费者：两份结果队列只在这里听，不另起 developer 进程，不订阅 SQS。"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path

import pytest

from app.database.mq import declared_result_queue_names, run_main_result_consumers
from app.main import lifespan


class _Connection:
    def __init__(self) -> None:
        self.is_closed = False

    async def close(self) -> None:
        self.is_closed = True


@pytest.mark.asyncio
async def test_main_process_consumes_both_result_queues(monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[str] = []
    cancelled: list[str] = []
    connection = _Connection()

    async def connect(url: str, **kwargs: object) -> _Connection:
        assert url == "amqp://example"
        assert kwargs["timeout"] == 1.5
        return connection

    async def consume(
        *,
        database: object,
        redis_client: object,
        connection: _Connection,
        queue_name: str,
    ) -> None:
        del database, redis_client, connection
        started.append(queue_name)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(queue_name)
            raise

    monkeypatch.setattr("app.database.mq.aio_pika.connect_robust", connect)
    monkeypatch.setattr("app.database.mq.workflow_v2_reply_consumer_forever", consume)

    task = asyncio.create_task(
        run_main_result_consumers(
            database=object(),
            redis_client=object(),
            rabbitmq_url="amqp://example",
            connect_timeout=1.5,
        )
    )
    for _ in range(20):
        if len(started) == 2:
            break
        await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert started == list(declared_result_queue_names())
    assert cancelled == started
    assert connection.is_closed is True


def test_startup_has_one_result_consumer_and_no_sqs() -> None:
    source = inspect.getsource(lifespan)
    assert source.count("run_main_result_consumers") == 1
    assert "subscribe_receive_message" not in source
    assert "subscribe_receive_message" not in inspect.getsource(run_main_result_consumers)
    root = Path(__file__).resolve().parents[1]
    assert not (root / "main_developer.py").exists()
    assert not (root / "app" / "main_developer.py").exists()
