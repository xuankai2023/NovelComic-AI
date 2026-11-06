"""应用自己的 trace id。格式和 W3C traceparent 不同。"""

import time
import uuid


def generate_trace_id() -> str:
    """`1-{unix 秒的 8 位 hex}-{uuid4 前 24 位 hex}`。"""

    version = "1"
    timestamp = format(int(time.time()), "08x")
    random_bits = uuid.uuid4().hex[:24]
    return f"{version}-{timestamp}-{random_bits}"
