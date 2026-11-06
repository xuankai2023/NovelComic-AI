import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_bluegreen_drain.py"
spec = importlib.util.spec_from_file_location("verify_bluegreen_drain", MODULE_PATH)
assert spec is not None and spec.loader is not None
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def test_complete_requires_inflight_and_webhook_counts() -> None:
    assert verify.drain_is_complete(
        {"inflight_count": 0, "submitted_webhook_invocation_count": 0}
    )
    assert not verify.drain_is_complete(
        {"inflight_count": 0, "submitted_webhook_invocation_count": 1}
    )
    assert not verify.drain_is_complete(
        {"inflight_count": 2, "submitted_webhook_invocation_count": 0}
    )


def test_verifier_fails_until_both_counts_are_zero() -> None:
    class Handler(BaseHTTPRequestHandler):
        calls = 0

        def do_GET(self) -> None:  # noqa: N802
            Handler.calls += 1
            body = {
                "inflight_count": 0 if Handler.calls > 1 else 1,
                "submitted_webhook_invocation_count": 0,
            }
            payload = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    try:
        port = server.server_address[1]
        import threading

        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        assert (
            verify.main(
                [
                    "--base-url",
                    f"http://127.0.0.1:{port}",
                    "--timeout-seconds",
                    "2",
                    "--poll-interval-seconds",
                    "0",
                ]
            )
            == 0
        )
    finally:
        server.shutdown()
        server.server_close()
