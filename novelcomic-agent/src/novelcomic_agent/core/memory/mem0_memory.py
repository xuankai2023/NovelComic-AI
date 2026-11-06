"""mem0 client. The server imports this only when memory is enabled."""


class Mem0Memory:
    def __init__(self) -> None:
        self.connected = True
