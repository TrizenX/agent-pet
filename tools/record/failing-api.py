#!/usr/bin/env python3
"""
An Anthropic endpoint that always fails, so `StopFailure` can be provoked.

`exhausted` is the state §7.1 calls the highest-value in the product, and it is
the only one no real event has ever entered. Its sole input is `StopFailure`.

This had been written off as "needs a genuine rate limit, cannot be
manufactured". That was wrong twice over. `rate_limit` is one of eight entries
in `BLOCK_REASONS` — overloaded, billing, auth, invalid_request and
server_error all produce the same `AGENT_BLOCKED` — so any API failure would
do. And an API failure needs no quota and no account: point the client at a
server that fails, with `ANTHROPIC_BASE_URL`. As far as the real client is
concerned, the failure is real.

**This is not a mock of our hook endpoint.** It replaces the API the agent
talks to, so the real client produces the real error and whatever hook that
really fires is what gets recorded. A fixture composed from documentation is
exactly what recording exists to replace (§11.1).

What is already known: run headless, neither variant emits `StopFailure`. Only
`UserPromptSubmit` and `SessionEnd` arrive — the turn fails and the session
ends. See `artifacts/real-session/FINDINGS.md`. Whether an *interactive*
session behaves the same is the open question this tool exists to settle, and
it is a question only a human at a keyboard can answer.

Usage:
    python3 tools/record/failing-api.py --mode rate_limit
    # then, in another terminal:
    ANTHROPIC_BASE_URL=http://127.0.0.1:48260 claude

Every response is a failure, so the session can do nothing else. Send one
prompt, watch it fail, and stop.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 48260

# The two ends of the spectrum. `rate_limit` is what the state is named for and
# makes the client retry with backoff; `auth` fails immediately, which is the
# faster experiment when all you want to know is which hooks fire.
MODES: dict[str, tuple[int, str, str]] = {
    "rate_limit": (429, "rate_limit_error", "number of requests has exceeded your rate limit"),
    "auth": (401, "authentication_error", "invalid x-api-key"),
    "overloaded": (529, "overloaded_error", "Overloaded"),
    "server_error": (500, "api_error", "Internal server error"),
}


def handler_for(status: int, err_type: str, message: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _fail(self) -> None:
            body = json.dumps(
                {"type": "error", "error": {"type": err_type, "message": message}}
            ).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            # Headers a real rate-limited response carries. The client reads
            # these to decide how to back off, so omitting them would change
            # its behaviour and make this less of a real failure.
            self.send_header("retry-after", "60")
            self.send_header("anthropic-ratelimit-requests-remaining", "0")
            self.send_header("anthropic-ratelimit-requests-reset", "2099-01-01T00:00:00Z")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            print(f"  {self.command} {self.path} -> {status} {err_type}", flush=True)

        do_GET = _fail
        do_POST = _fail

        def log_message(self, *args: object) -> None:
            """Silence the default access log; `_fail` prints a better one."""

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=sorted(MODES), default="rate_limit")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()

    status, err_type, message = MODES[args.mode]
    print(f"failing every request with {status} {err_type}")
    print(f"listening on http://127.0.0.1:{args.port}\n")
    print("point a real session at it:")
    print(f"  ANTHROPIC_BASE_URL=http://127.0.0.1:{args.port} claude\n")
    try:
        HTTPServer(("127.0.0.1", args.port), handler_for(status, err_type, message)).serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
