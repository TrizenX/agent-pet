#!/usr/bin/env python3
"""
The assumption the whole product rests on, photographed.

§1.1: a pet you cannot see is worse than no pet. Many people run their terminal
full-screen, and a plain always-on-top window does not survive that — Spike A
measured the baseline at 12 visible samples out of 57 before the fix.

That spike proved the fix by asking the window server whether our window was
onscreen and at layer 25. Good evidence, and it stops one step short: the window
server will happily call a window onscreen while it draws nothing a human could
see. Nobody has ever looked at the pet over a full-screen app.

So this drives a real app into a real full-screen Space and reads the pixels.

  * `CGWindowListCopyWindowInfo` for the window's own account of itself.
  * Two screenshots of the same full-screen Space — one with the pet running,
    one taken a second after killing it — and a diff of the pet's rectangle
    between them. Whatever changed there is the pet, and nothing else. If it
    was covered, the two frames are identical and this fails.

    The first attempt counted dark pixels against a control rectangle beside
    the pet, on the assumption that a full-screen page is pale. On a dark
    system both rectangles came out 97% dark and the measure said nothing. A
    difference between two frames does not care what colour anything is.

Needs Screen Recording (for the capture) and Accessibility (to send the
full-screen keystroke). Restores the screen when it is done.

Usage:
    python3 tools/layout/fullscreen.py --binary path/to/agent-pet
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
from PIL import Image, ImageChops

PORT = 48232
OURS = ("Agent Pet", "agent-pet")
# A pixel counts as changed when it moves by more than sensor/compression noise.
CHANGED = 24


def osa(script: str) -> str:
    return subprocess.run(
        ["osascript", "-e", script], capture_output=True, text=True, check=False
    ).stdout.strip()


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
    raise SystemExit("the pet never reported a connected webview")


def is_fullscreen(app: str = "TextEdit") -> bool:
    """Whether `app` owns a window filling the display, edge to edge.

    Asked of the window server rather than the accessibility layer. TextEdit's
    windows do not expose `AXFullScreen` here at all — querying it returns
    nothing whether or not the app is full-screen, which is the worst kind of
    check. Geometry is unambiguous: a full-screen window spans the display's
    full width and reaches its bottom edge, while an ordinary one does not.
    """
    display = Quartz.CGMainDisplayID()
    dw, dh = Quartz.CGDisplayPixelsWide(display), Quartz.CGDisplayPixelsHigh(display)
    infos = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    for w in infos or []:
        if w.get("kCGWindowOwnerName") != app:
            continue
        b = w["kCGWindowBounds"]
        if int(b["X"]) == 0 and int(b["Width"]) == dw and int(b["Y"] + b["Height"]) == dh:
            return True
    return False


def our_window() -> dict | None:
    """What the window server thinks of our window, right now."""
    infos = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    for w in infos or []:
        owner = w.get("kCGWindowOwnerName", "")
        title = w.get("kCGWindowName", "") or ""
        if owner in OURS or title in OURS:
            b = w["kCGWindowBounds"]
            return {
                "layer": w.get("kCGWindowLayer"),
                "onscreen": bool(w.get("kCGWindowIsOnscreen")),
                "bounds": (int(b["X"]), int(b["Y"]), int(b["Width"]), int(b["Height"])),
            }
    return None


def changed_fraction(a: Image.Image, b: Image.Image, box: tuple[int, int, int, int]) -> float:
    """How much of `box` differs between two frames of the same screen."""
    diff = ImageChops.difference(a.crop(box).convert("L"), b.crop(box).convert("L"))
    histogram = diff.histogram()
    total = sum(histogram)
    return sum(histogram[CHANGED:]) / total if total else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--shot", default="artifacts/layout/fullscreen.png")
    args = ap.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.exists():
        raise SystemExit(f"{binary} does not exist — `pnpm tauri build --no-bundle` first")

    pet = subprocess.Popen(
        [str(binary)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "PET_PORT": str(PORT)},
    )
    fullscreen_entered = False

    try:
        wait_for_webview()
        # Give the bubble something to say, so this measures the pet a user
        # would actually see rather than an empty transparent window.
        post(
            {
                "hook_event_name": "PreToolUse",
                "session_id": "fs",
                "cwd": "/w/agent-pet",
                "tool_name": "Bash",
                "tool_input": {"command": "pnpm tauri build"},
            }
        )
        time.sleep(1.0)

        before = our_window()
        if not before:
            print("the pet's window is not in the window list at all")
            return 1
        print(f"on the desktop:      layer {before['layer']}, onscreen {before['onscreen']}")

        # A real full-screen Space, which is the case that breaks naive
        # always-on-top windows — not a borderless window we sized ourselves.
        #
        # The document is created explicitly. Activating TextEdit with no open
        # file raises its open-file dialog instead, the keystroke goes to the
        # dialog, and nothing enters full-screen — which is exactly what
        # happened on the first run of this script, and it reported a pass.
        # From a known state. The keystroke toggles, so starting with TextEdit
        # already full-screen from a previous run would take it *out* — which
        # happened, and looked like the keystroke not working.
        osa('tell application "TextEdit" to quit saving no')
        time.sleep(1.5)
        doc = Path(args.shot).parent / "fullscreen-probe.txt"
        doc.parent.mkdir(parents=True, exist_ok=True)
        doc.write_text("agent-pet full-screen probe\n")
        subprocess.run(["open", "-e", str(doc)], check=True)
        time.sleep(2.5)

        osa('tell application "TextEdit" to activate')
        time.sleep(1.0)
        osa('tell application "System Events" to keystroke "f" using {command down, control down}')
        fullscreen_entered = True
        # The Space transition animates; measuring through it reads garbage.
        time.sleep(4.5)

        # The precondition. Without it this measures the pet over an ordinary
        # desktop and calls that a full-screen pass.
        if not is_fullscreen():
            print("TextEdit never entered full-screen — nothing was tested")
            return 1
        print("TextEdit is full-screen")

        after = our_window()
        if not after:
            print("over full-screen:    the pet vanished from the window list")
            return 1
        print(f"over full-screen:    layer {after['layer']}, onscreen {after['onscreen']}")

        shot = Path(args.shot)
        shot.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["screencapture", "-x", "-o", str(shot)], check=True)

        # The same Space, a second later, with the pet gone. Everything that
        # differs inside its rectangle was the pet.
        pet.terminate()
        pet.wait(timeout=5)
        time.sleep(1.2)
        without = shot.with_name("fullscreen-without-pet.png")
        subprocess.run(["screencapture", "-x", "-o", str(without)], check=True)

        im, bare = Image.open(shot), Image.open(without)
        scale = im.width / Quartz.CGDisplayPixelsWide(Quartz.CGMainDisplayID())
        x, y, w, h = (int(v * scale) for v in after["bounds"])
        pet_box = (x, y, min(x + w, im.width), min(y + h, im.height))
        # A rectangle beside it, where nothing of ours ever was. Two frames of
        # the same static page should be identical there, which is what makes
        # the pet's number mean something.
        cx = max(0, x - w - 20)
        control_box = (cx, y, cx + (pet_box[2] - pet_box[0]), pet_box[3])

        drew = changed_fraction(im, bare, pet_box)
        noise = changed_fraction(im, bare, control_box)
        print(f"\nscreenshot -> {shot}")
        print(f"pixels the pet was drawing: {drew:.1%}  (background noise {noise:.1%})")

        problems = []
        if after["layer"] != 25:
            problems.append(f"window level is {after['layer']}, not 25")
        if not after["onscreen"]:
            problems.append("the window server no longer calls it onscreen")
        # The bubble alone is a few per cent of the window; the sprite adds
        # more. Anything under this and there is nothing to look at.
        if drew < 0.02:
            problems.append(f"only {drew:.1%} of the pet's rectangle changed when it quit")
        if drew <= max(noise * 3, 0.005):
            problems.append(
                "the pet's rectangle changed no more than the untouched page beside it"
            )

        if problems:
            print("\nFAIL")
            for p in problems:
                print(f"  - {p}")
            return 1
        print("\nthe pet is visible over a full-screen app")
        return 0
    finally:
        if pet.poll() is None:
            pet.terminate()
        if fullscreen_entered:
            osa(
                'tell application "System Events" to keystroke "f" '
                "using {command down, control down}"
            )
            time.sleep(2.0)
        osa('tell application "TextEdit" to quit saving no')
        try:
            pet.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pet.kill()


if __name__ == "__main__":
    sys.exit(main())
