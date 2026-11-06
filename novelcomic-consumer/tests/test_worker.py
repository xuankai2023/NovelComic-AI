import asyncio

from app.tasks.worker import EmptyWorker


async def test_empty_worker_stops_cleanly() -> None:
    worker = EmptyWorker()
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(0)
    assert not task.done()
    worker.stop()
    await task
    assert task.done()
