#!/usr/bin/env python3
"""
Does the pet put pixels in its own window?

TZX-97 was invisible for a day while every other check passed. `pnpm verify` is
jsdom, which composites nothing. `tools/layout/check.py` read the bubble's
geometry out of the webview and reported a tidy `208x37 at 106,231` — because
WebKit computes layout whether or not it paints, so that harness was green
throughout the outage. `tools/layout/fullscreen.py` did catch it, and it needs a
full-screen Space, TextEdit, Accessibility, Screen Recording and about a minute.

This is the cheap one, and it is the instrument that finally identified the bug:
capture the window **by id**. `screencapture -l` returns the window's own
contents, so unlike a screen grab it does not care which Space is active, what is
behind the window, whether anything is animating, or whether the window server
counts it as onscreen. It is the only measurement in this project that was never
confounded.

What it asserts, and why each one is a bug that actually happened:

  * **something opaque is painted.** A fully transparent page makes WKWebView
    composite none of the layer, so the sprite and the bubble vanish along with
    the empty space. Alpha extrema went from `(3, 255)` to `(0, 0)`.
  * **not the whole rectangle.** `background: #ff0000` on `.pet-root` was the
    experiment that found the bug, and it fills 93 % of the window. Shipping that
    would put an opaque block over the user's editor all day (§9.1).
  * **the window is still see-through.** The other tempting fix is to make the
    window opaque, which trades an invisible pet for a grey box.

Usage:
    python3 tools/layout/paints.py --binary packages/pet-core/src-tauri/target/release/agent-pet

Needs Screen Recording. macOS only — this is exactly the platform-specific
compositing behaviour that no cross-platform check can stand in for.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import Quartz
from PIL import Image

PORT = 48233
# Alpha at or below this is the near-transparent backdrop, not content. The
# backdrop is 3/255 by design; content is opaque.
BACKDROP = 8
# The bubble plus a 0.75-scaled sprite measured 5.99 % of the window. Two per
# cent is a floor low enough for a small pet at minimum scale and high enough
# that a stray antialiased pixel cannot pass.
MIN_CONTENT = 0.02
# Above this the window is a filled block rather than a pet — the `#ff0000`
# failure, which measured 93 %.
MAX_CONTENT = 0.60


def health(timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=timeout) as r:
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


def post(body: dict) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/event/claude-code",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=5).read()


def window_id() -> int | None:
    """Our titled window's id. The app also owns two NSStatusBarWindows."""
    for w in (
        Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionAll | Quartz.kCGWindowListExcludeDesktopElements,
            Quartz.kCGNullWindowID,
        )
        or []
    ):
        if w.get("kCGWindowOwnerName") in ("Agent Pet", "agent-pet") and w.get("kCGWindowName"):
            return int(w["kCGWindowNumber"])
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--shot", default="artifacts/layout/paints.png")
    args = ap.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.exists():
        raise SystemExit(
            f"{binary} does not exist — `pnpm tauri build --no-bundle` first.\n"
            "A plain `cargo build --release` loads devUrl and paints nothing, which is\n"
            "indistinguishable from the bug this checks for."
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
        # Something to say, so the bubble is part of what is measured. An idle
        # pet is a smaller target and a less useful one.
        post(
            {
                "hook_event_name": "PreToolUse",
                "session_id": "paints",
                "cwd": "/w/agent-pet",
                "tool_name": "Bash",
                "tool_input": {"command": "pnpm tauri build"},
            }
        )
        time.sleep(2.5)

        wid = window_id()
        if wid is None:
            print("the pet's window is not in the window list at all")
            return 1

        shot = Path(args.shot)
        shot.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["screencapture", "-x", "-o", "-l", str(wid), str(shot)],
            check=True,
        )
        im = Image.open(shot)
        if im.mode != "RGBA":
            print(f"capture has no alpha channel (mode {im.mode}) — cannot judge transparency")
            return 1

        alpha = im.getchannel("A")
        lo, hi = alpha.getextrema()
        total = im.width * im.height
        content = sum(1 for p in alpha.get_flattened_data() if p > BACKDROP) / total

        print(f"window {im.width}x{im.height} captured by id {wid}")
        print(f"alpha extrema      {lo}, {hi}")
        print(f"content pixels     {content:.2%}  (alpha > {BACKDROP})")

        problems = []
        if hi < 200:
            problems.append(
                f"nothing opaque was painted (max alpha {hi}) — the pet is invisible. "
                "A fully transparent page makes WKWebView composite none of the layer."
            )
        if content < MIN_CONTENT:
            problems.append(f"only {content:.2%} of the window has content, under {MIN_CONTENT:.0%}")
        if content > MAX_CONTENT:
            problems.append(
                f"{content:.2%} of the window is painted, over {MAX_CONTENT:.0%} — this is a "
                "filled block, not a pet, and the user looks past it all day (§9.1)"
            )
        if lo > BACKDROP:
            problems.append(
                f"the window is not see-through (min alpha {lo}) — an opaque overlay is worse "
                "than an invisible one"
            )

        print(f"\nscreenshot -> {shot}")
        if problems:
            print("\nFAIL")
            for p in problems:
                print(f"  - {p}")
            return 1
        print("\nthe pet is painting pixels, and the window is still transparent")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
