#!/usr/bin/env python3
"""
M0 Spike A — does the overlay survive *entering* full screen?

The level sweep only proves the overlay is visible when its window is created
while a full-screen space is already active. That is not the case users hit.
The case users hit is: pet already running, then they press ctrl-cmd-F.

macOS builds a new space on that transition, and a window's space membership is
decided when it is ordered in. If `canJoinAllSpaces` is not honoured across the
transition, the pet vanishes exactly when the user goes full-screen — which is
the failure mode Spike A exists to catch.

This samples the window server once a second and correlates our window's
onscreen state with whether a full-screen space is active, so the answer comes
from measurement rather than from reading Apple's documentation.

Usage:
    python3 watch_transition.py --seconds 60
    # then toggle full screen on and off a couple of times
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import Quartz

OWNER = "agent-pet"
TITLE = "Agent Pet"


def onscreen():
    return Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
    ) or []


def all_windows():
    return Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID
    ) or []


def is_ours(w) -> bool:
    return (w.get("kCGWindowOwnerName") or "") == OWNER and (w.get("kCGWindowName") or "") == TITLE


def sample() -> dict:
    on = onscreen()
    mine_on = next((w for w in on if is_ours(w)), None)
    mine_any = next((w for w in all_windows() if is_ours(w)), None)
    return {
        "fullscreen": any("Fullscreen" in (w.get("kCGWindowName") or "") for w in on),
        "exists": mine_any is not None,
        "onscreen": mine_on is not None,
        "layer": int(mine_on["kCGWindowLayer"]) if mine_on else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    print("Toggle full screen on and off while this runs (ctrl-cmd-F).\n")
    print(f"{'t':>4} {'fullscreen':>11} {'exists':>7} {'onscreen':>9} {'layer':>6}")

    rows = []
    for t in range(args.seconds):
        s = sample()
        s["t"] = t
        rows.append(s)
        print(
            f"{t:>4} {str(s['fullscreen']):>11} {str(s['exists']):>7} "
            f"{str(s['onscreen']):>9} {str(s['layer']):>6}"
        )
        time.sleep(1)

    fs = [r for r in rows if r["fullscreen"]]
    normal = [r for r in rows if not r["fullscreen"]]
    fs_visible = sum(1 for r in fs if r["onscreen"])
    normal_visible = sum(1 for r in normal if r["onscreen"])

    print("\n--- summary ---")
    print(f"samples with a full-screen space : {len(fs):>3}  overlay visible in {fs_visible}")
    print(f"samples on the normal desktop    : {len(normal):>3}  overlay visible in {normal_visible}")

    if not fs:
        verdict = "INCONCLUSIVE — no full-screen space was ever active"
    elif fs_visible == len(fs):
        verdict = "PASS — overlay stayed visible across the full-screen transition"
    elif fs_visible == 0:
        verdict = "FAIL — overlay is dropped whenever a full-screen space is active"
    else:
        verdict = f"PARTIAL — visible in {fs_visible}/{len(fs)} full-screen samples"
    print(verdict)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"verdict": verdict, "samples": rows}, indent=2))
        print(f"results -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
