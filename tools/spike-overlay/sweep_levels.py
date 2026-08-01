#!/usr/bin/env python3
"""
M0 Spike A — sweep window level × collectionBehavior against a full-screen app.

Starts the overlay binary once per combination, asks the window server whether
the window is actually onscreen, and kills it. Run this while a full-screen app
owns the display; the script refuses to run otherwise, because that is the only
condition the spike cares about.

Usage:
    python3 sweep_levels.py --binary ../../packages/pet-core/src-tauri/target/debug/agent-pet
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import Quartz

OWNER = "agent-pet"
TITLE = "Agent Pet"

# NSWindowCollectionBehavior bits.
CAN_JOIN_ALL_SPACES = 1 << 0
TRANSIENT = 1 << 3
STATIONARY = 1 << 4
IGNORES_CYCLE = 1 << 6
FULL_SCREEN_AUXILIARY = 1 << 8

BASE = CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY

# Named window levels worth trying, cheapest-first.
LEVELS = [
    (25, "NSStatusWindowLevel"),
    (101, "NSPopUpMenuWindowLevel"),
    (200, "NSScreenSaverWindowLevel-ish"),
    (1000, "NSScreenSaverWindowLevel"),
]

BEHAVIOURS = [
    (BASE, "canJoinAllSpaces|stationary|ignoresCycle|fullScreenAuxiliary"),
    (BASE | TRANSIENT, "…|transient"),
    (CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY, "canJoinAllSpaces|fullScreenAuxiliary"),
]


def onscreen_windows():
    return Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
    ) or []


def fullscreen_active() -> bool:
    return any("Fullscreen" in (w.get("kCGWindowName") or "") for w in onscreen_windows())


def probe() -> dict | None:
    for w in onscreen_windows():
        if (w.get("kCGWindowOwnerName") or "") == OWNER and (w.get("kCGWindowName") or "") == TITLE:
            b = w.get("kCGWindowBounds") or {}
            return {
                "layer": int(w.get("kCGWindowLayer", 0)),
                "alpha": float(w.get("kCGWindowAlpha", 1.0)),
                "bounds": [int(b.get(k, 0)) for k in ("X", "Y", "Width", "Height")],
            }
    return None


def run_case(binary: Path, level: int, behaviour: int, settle: float) -> dict | None:
    env = dict(os.environ, PET_WINDOW_LEVEL=str(level), PET_COLLECTION_BEHAVIOUR=str(behaviour))
    proc = subprocess.Popen(
        [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        deadline = time.time() + settle
        seen = None
        while time.time() < deadline:
            seen = probe()
            if seen:
                break
            time.sleep(0.25)
        return seen
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True, type=Path)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--force", action="store_true", help="run even with no full-screen app")
    ap.add_argument("--wait", type=int, default=180, help="seconds to wait for a full-screen app")
    args = ap.parse_args()

    if not fullscreen_active() and not args.force:
        # Entering full screen cannot be automated without Accessibility
        # permission, so wait for the human instead of bailing.
        print(f"Waiting up to {args.wait}s for a full-screen app — press ctrl-cmd-F now.")
        deadline = time.time() + args.wait
        while time.time() < deadline and not fullscreen_active():
            time.sleep(1)
        if not fullscreen_active():
            print("Timed out with no full-screen app. Nothing measured.")
            return 2
        print("Full-screen detected. Stay in it until the sweep finishes.\n")

    print(f"full-screen app active: {fullscreen_active()}")
    print(f"{'level':>6}  {'behaviour':<52} {'onscreen':>8}  {'reported layer':>14}")
    results = []
    for level, lname in LEVELS:
        for behaviour, bname in BEHAVIOURS:
            seen = run_case(args.binary, level, behaviour, args.settle)
            results.append(
                {
                    "level": level,
                    "level_name": lname,
                    "behaviour": behaviour,
                    "behaviour_name": bname,
                    "onscreen": seen is not None,
                    "observed": seen,
                }
            )
            print(
                f"{level:>6}  {bname:<52} {('YES' if seen else 'no'):>8}  "
                f"{(seen['layer'] if seen else '-'):>14}"
            )

    wins = [r for r in results if r["onscreen"]]
    print(f"\n{len(wins)}/{len(results)} combinations visible over a full-screen app")
    if wins:
        best = min(wins, key=lambda r: r["level"])
        print(f"lowest level that works: {best['level']} ({best['level_name']}) with {best['behaviour_name']}")
    else:
        print("NONE worked — escalate: NSPanel nonactivating style mask, or a different approach")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(results, indent=2))
        print(f"results -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
