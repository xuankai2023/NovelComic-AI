import asyncio


class EmptyWorker:
    """Lifecycle placeholder. It intentionally consumes no business queue."""

    def __init__(self) -> None:
        self._stop_event = asyncio.Event()

    async def run(self) -> None:
        await self._stop_event.wait()

    def stop(self) -> None:
        self._stop_event.set()
