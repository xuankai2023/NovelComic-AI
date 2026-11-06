"""每条日志补上 trace_id。上下文空着时打印 N/A。"""

import logging
import sys

from app.utils.trace_context import get_trace_id

LOG_FORMAT = "%(asctime)s | %(levelname)-8s | [trace_id=%(trace_id)s] | %(name)s - %(message)s"


class TraceIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = get_trace_id() or "N/A"
        return True


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("novelcomic.consumer")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not any(isinstance(item, TraceIdFilter) for item in logger.filters):
        logger.addFilter(TraceIdFilter())
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        handler.addFilter(TraceIdFilter())
        logger.addHandler(handler)
    return logger


log = _build_logger()
