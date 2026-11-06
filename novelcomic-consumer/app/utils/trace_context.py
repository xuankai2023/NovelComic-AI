"""Consumer 当前任务上的 trace id。这里不新造 ID。"""

from contextvars import ContextVar

trace_id_context: ContextVar[str | None] = ContextVar("trace_id", default=None)


def set_trace_id(trace_id: str | None) -> None:
    trace_id_context.set(trace_id)


def get_trace_id() -> str | None:
    return trace_id_context.get(None)


def clear_trace_id() -> None:
    trace_id_context.set(None)
