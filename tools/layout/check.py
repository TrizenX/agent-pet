#!/usr/bin/env python3
"""
Does any of it actually appear on screen?

Every layout bug this project has shipped was invisible to the test suite and
obvious the moment anyone looked: a bubble clipped at the window edge, a badge
floating a hundred pixels above a small pet, a window shorter than the sprite it
was drawing. jsdom does no layout, so none of it can be asserted there —
`textContent` is the same whether or not a line is truncated.

So this runs the real binary, drives real payloads through it, and reads the
geometry WebKit actually computed. The screenshot is evidence for a human; the
assertions are on the numbers.

Slow — a release build, a launch, and a few seconds of settling — so it is not
part of `pnpm verify`. Run it before tagging, and after anything that touches
the window, the bubble or the sprite.

Usage:
    python3 tools/layout/check.py --binary packages/pet-core/src-tauri/target/release/agent-pet
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

PORT = 48231
LAYOUT = re.compile(
    r"\[layout\] bubble (\d+)x(\d+) at (-?\d+),(-?\d+) "
    r"window (\d+)x(\d+) gap (-?\d+) truncated (\d+) outside (\w+)"
)


@dataclass
class Layout:
    w: int
    h: int
    left: int
    top: int
    win_w: int
    win_h: int
    gap: int
    truncated: int
    outside: bool

    @property
    def summary(self) -> str:
        return (
            f"{self.w}x{self.h} at {self.left},{self.top} in {self.win_w}x{self.win_h}, "
            f"gap {self.gap}px, {self.truncated} truncated"
        )


def post(body: dict) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/event/claude-code",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=5).read()


def wait_for_webview(timeout: float = 30.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                if json.load(r)["webview"]["connected"]:
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit("the pet never reported a connected webview; nothing to measure")


# One case per layout that has actually broken. Each drives the pet into a shape
# and names what would be wrong with it.
CASES: list[tuple[str, list[dict]]] = [
    (
        "a long command in one line",
        [
            {
                "hook_event_name": "PreToolUse",
                "session_id": "one",
                "cwd": "/w/agent-pet",
                "tool_name": "Bash",
                "tool_input": {"command": "pnpm tauri build --no-bundle --verbose"},
            }
        ],
    ),
    (
        "five sessions at once",
        [
            {
                "hook_event_name": "PreToolUse",
                "session_id": f"s{i}",
                "cwd": f"/w/project-number-{i}",
                "tool_name": "Edit",
                "tool_input": {"file_path": f"/x/some-long-file-name-{i}.ts"},
            }
            for i in range(5)
        ],
    ),
    (
        "one of them waiting on the user",
        [
            {
                "hook_event_name": "Notification",
                "session_id": "s2",
                "cwd": "/w/project-number-2",
                "notification_type": "permission_prompt",
            }
        ],
    ),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--shot", default="artifacts/layout/pet.png")
    args = ap.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.exists():
        raise SystemExit(
            f"{binary} does not exist — build it with `pnpm tauri build --no-bundle`.\n"
            "A plain `cargo build --release` is not enough: it still loads devUrl."
        )

    env_port = {"PET_PORT": str(PORT)}
    proc = subprocess.Popen(
        [str(binary)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**__import__("os").environ, **env_port},
    )
    lines: list[str] = []

    def drain() -> None:
        while proc.stdout and (line := proc.stdout.readline()):
            lines.append(line)

    import threading

    threading.Thread(target=drain, daemon=True).start()

    try:
        wait_for_webview()
        print(f"pet is up on {PORT}, webview connected\n")

        failures: list[str] = []
        seen = 0

        for name, events in CASES:
            before = len(lines)
            for e in events:
                post(e)
            time.sleep(1.5)

            measured = [LAYOUT.search(line) for line in lines[before:]]
            found = [m for m in measured if m]
            if not found:
                failures.append(f"{name}: the bubble never reported its geometry")
                continue

            g = found[-1]
            layout = Layout(
                *(int(g.group(i)) for i in range(1, 9)),  # type: ignore[arg-type]
                outside=g.group(9) == "true",
            )
            seen += 1

            problems = []
            if layout.truncated:
                problems.append(f"{layout.truncated} line(s) truncated")
            if layout.outside:
                problems.append("bubble extends outside the window")
            if layout.gap < 0:
                problems.append(f"bubble overlaps the pet by {-layout.gap}px")
            if layout.gap > 120:
                problems.append(f"bubble floats {layout.gap}px above the pet")

            status = "FAIL" if problems else "ok  "
            print(f"[{status}] {name}\n         {layout.summary}")
            for p in problems:
                print(f"         -> {p}")
                failures.append(f"{name}: {p}")

        # The precondition M2 taught this project to write: refuse to report a
        # pass when the instrument saw nothing.
        if seen == 0:
            print("\nnothing was measured — this is not a pass")
            return 1

        shot = Path(args.shot)
        shot.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["screencapture", "-x", "-o", str(shot)], check=False)
        print(f"\nscreenshot -> {shot}")

        if failures:
            print(f"\n{len(failures)} problem(s):")
            for f in failures:
                print(f"  - {f}")
            return 1
        print(f"\n{seen}/{seen} layouts fit")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
