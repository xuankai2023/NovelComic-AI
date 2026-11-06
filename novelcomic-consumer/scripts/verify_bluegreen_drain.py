"""Check a drained consumer without replacing the production cutover script.

Passing requires both ``inflight_count`` and
``submitted_webhook_invocation_count`` to be 0. Stream PEL and outbox stay
outside this check.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from typing import Any


def drain_is_complete(body: dict[str, Any]) -> bool:
    return body.get("inflight_count") == 0 and body.get("submitted_webhook_invocation_count") == 0


def _get_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("consumer status must be a JSON object")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify consumer drain counts")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=300)
    parser.add_argument("--poll-interval-seconds", type=float, default=5)
    args = parser.parse_args(argv)
    status_url = args.base_url.rstrip("/") + "/ops/consumer/status"
    deadline = time.monotonic() + args.timeout_seconds
    last: dict[str, Any] = {}
    while True:
        last = _get_json(status_url)
        if drain_is_complete(last):
            print(json.dumps({"ok": True, "status": last}, ensure_ascii=False))
            return 0
        if time.monotonic() >= deadline:
            print(json.dumps({"ok": False, "status": last}, ensure_ascii=False))
            return 1
        time.sleep(args.poll_interval_seconds)


if __name__ == "__main__":
    sys.exit(main())
