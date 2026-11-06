from abc import ABC, abstractmethod


class BasePoster(ABC):
    @abstractmethod
    async def a_post(self, **kwargs) -> None:
        pass
