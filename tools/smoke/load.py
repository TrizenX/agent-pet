#!/usr/bin/env python3
"""
Does it survive being used?

`pnpm verify` checks the logic. `tools/layout/check.py` checks that what it
draws is visible. Nothing checked that it stays up, and the worst bug of the
project so far lived in exactly that gap: every console line the frontend wrote
ran inline on the UI thread, so **thirty events wedged the app** so completely
that the HTTP server stopped answering. It passed 468 unit tests, five
reviewers, and the layout harness. It was found by accident, hours later, by a
soak that died twenty seconds in and looked like a memory leak.

The check that would have caught it in ten seconds is this one: fire a
workday's worth of events at the real binary and see whether it is still there.

Deliberately not a soak. A soak asks whether memory grows over hours; this asks
whether the thing survives a busy minute, which is a different question and a
much cheaper one.

Usage:
    python3 tools/smoke/load.py --binary packages/pet-core/src-tauri/target/release/agent-pet
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PORT = 48250
# Five events per session, thirty sessions: 150 events, which is a busy few
# minutes of real work compressed into half a minute.
SESSIONS = 30
# Beyond this the pet is not answering in any sense the agent would tolerate —
# I2 allows the agent to wait 2 s once, and that is for a pet that has died.
SLOW_MS = 500


def endpoint(path: str) -> str:
    return f"http://127.0.0.1:{PORT}{path}"


def post(body: dict, timeout: float = 3.0) -> float:
    """Post one hook payload. Returns the round trip in milliseconds."""
    req = urllib.request.Request(
        endpoint("/event/claude-code"),
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    start = time.perf_counter()
    urllib.request.urlopen(req, timeout=timeout).read()
    return (time.perf_counter() - start) * 1000


def health(timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(endpoint("/health"), timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def wait_for_webview(proc: subprocess.Popen, timeout: float = 40.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise SystemExit(f"the pet exited before it was ready (code {proc.returncode})")
        h = health()
        if h and h.get("webview", {}).get("connected"):
            return
        time.sleep(0.25)
    raise SystemExit("the pet never reported a connected webview")


def session_events(n: int) -> list[dict]:
    """One session's worth of work.

    Varied on purpose. The tool changes the pet's state, the file changes the
    speech bubble, and both together change what the frontend renders and logs —
    which is what the wedge was made of. A hundred and fifty identical events
    would exercise the queue and nothing above it.
    """
    sid = f"load-{n}"
    cwd = f"/w/project-{n % 4}"
    tool, arg = [
        ("Bash", {"command": f"pnpm test --filter pkg-{n}"}),
        ("Edit", {"file_path": f"/x/module-{n}.ts"}),
        ("Grep", {"pattern": f"TODO-{n}"}),
        ("Read", {"file_path": f"/x/notes-{n}.md"}),
    ][n % 4]
    return [
        {"hook_event_name": "SessionStart", "session_id": sid, "cwd": cwd},
        {"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": cwd},
        {"hook_event_name": "PreToolUse", "session_id": sid, "cwd": cwd, "tool_name": tool,
         "tool_input": arg},
        {"hook_event_name": "PostToolUse", "session_id": sid, "cwd": cwd, "tool_name": tool},
        {"hook_event_name": "Stop", "session_id": sid, "cwd": cwd},
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--sessions", type=int, default=SESSIONS)
    args = ap.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.exists():
        raise SystemExit(
            f"{binary} does not exist — `pnpm tauri build --no-bundle` first.\n"
            "A plain `cargo build --release` still loads devUrl and proves nothing."
        )
    if health():
        raise SystemExit(f"something is already listening on {PORT}; stop it first")

    proc = subprocess.Popen(
        [str(binary)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "PET_PORT": str(PORT)},
    )

    try:
        wait_for_webview(proc)
        print(f"pet is up on {PORT}, webview connected\n")

        latencies: list[float] = []
        sent = 0
        died_at: str | None = None

        for n in range(args.sessions):
            for body in session_events(n):
                try:
                    latencies.append(post(body))
                    sent += 1
                except Exception as e:
                    died_at = (
                        f"stopped answering after {sent} events "
                        f"({n} sessions in): {type(e).__name__}"
                    )
                    break
            if died_at:
                break
            # Roughly a session a second: fast enough to be a storm, slow
            # enough that this is load rather than a benchmark.
            time.sleep(1.0)

        h = health(timeout=5.0)
        alive = proc.poll() is None

        problems: list[str] = []
        if died_at:
            problems.append(died_at)
        if not alive:
            problems.append(f"the process exited during the run (code {proc.returncode})")
        if not h:
            problems.append("it is not answering /health after the run")
        else:
            events = h["events"]
            if events["dropped"]:
                problems.append(f"{events['dropped']} events were dropped")
            if events["delivered"] < sent:
                problems.append(
                    f"only {events['delivered']} of {sent} events reached the webview"
                )
            if not h["webview"]["connected"]:
                problems.append("the webview disconnected")

        # The precondition this project keeps having to relearn: refuse to
        # report a pass on a run that measured nothing.
        if sent < 5:
            print(f"only {sent} events were sent — this is not a pass")
            return 1

        p50 = statistics.median(latencies)
        worst = max(latencies)
        print(f"sent      {sent} events over {args.sessions} sessions")
        if h:
            print(f"delivered {h['events']['delivered']}, dropped {h['events']['dropped']}")
        print(f"round trip median {p50:.2f} ms, worst {worst:.1f} ms")

        if worst > SLOW_MS:
            problems.append(f"one round trip took {worst:.0f} ms, over the {SLOW_MS} ms ceiling")

        if problems:
            print("\nFAIL")
            for p in problems:
                print(f"  - {p}")
            return 1
        print("\nit survived being used")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
