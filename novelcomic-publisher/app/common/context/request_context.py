"""HTTP 和当前连接上的 trace id。缺省是 "-"。"""

from contextvars import ContextVar

trace_id_context: ContextVar[str | None] = ContextVar("trace_id_context", default=None)


class RequestContext:
    @staticmethod
    def set_trace_id(trace_id: str) -> None:
        trace_id_context.set(trace_id)

    @staticmethod
    def get_trace_id() -> str:
        return trace_id_context.get() or "-"
