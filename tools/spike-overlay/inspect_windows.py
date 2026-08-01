#!/usr/bin/env python3
"""
M0 Spike A — verify the overlay's window level from outside the app.

Reading the level back through the same Objective-C call that set it proves
nothing. This asks the window server instead, via CGWindowListCopyWindowInfo,
so the evidence is independent of our own code.

What matters:
  * our window's kCGWindowLayer must be 25 (NSStatusWindowLevel). Tauri's
    `alwaysOnTop` alone yields 3 (NSFloatingWindowLevel), which a full-screen
    app still covers.
  * the window must stay onscreen while a full-screen app owns the display.

Requires pyobjc-framework-Quartz. Needs no Screen Recording permission —
geometry and layer are readable without it; only pixel capture is gated.

Usage:
    python3 inspect_windows.py                 # snapshot
    python3 inspect_windows.py --watch 30      # sample once a second for 30s
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import Quartz

# Matched against both the owner process name and the window title: an
# un-bundled dev build reports its executable name ("agent-pet") as the owner,
# while a bundled .app reports the product name.
OURS = ("Agent Pet", "agent-pet")

# NSWindowCollectionBehavior bits we care about, for reporting.
BEHAVIOUR_BITS = {
    1 << 0: "canJoinAllSpaces",
    1 << 4: "stationary",
    1 << 6: "ignoresCycle",
    1 << 8: "fullScreenAuxiliary",
}


def windows() -> list[dict]:
    info = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    out = []
    for w in info or []:
        b = w.get("kCGWindowBounds") or {}
        out.append(
            {
                "owner": w.get("kCGWindowOwnerName") or "",
                "name": w.get("kCGWindowName") or "",
                "layer": int(w.get("kCGWindowLayer", 0)),
                "onscreen": bool(w.get("kCGWindowIsOnscreen", False)),
                "alpha": round(float(w.get("kCGWindowAlpha", 1.0)), 3),
                "bounds": [int(b.get("X", 0)), int(b.get("Y", 0)), int(b.get("Width", 0)), int(b.get("Height", 0))],
            }
        )
    return out


def is_ours(w: dict) -> bool:
    return w["owner"] in OURS or w["name"] in OURS


def ours(ws: list[dict]) -> dict | None:
    # Prefer the titled window; an un-bundled build also spawns untitled helpers.
    candidates = [w for w in ws if is_ours(w)]
    titled = [w for w in candidates if w["name"] in OURS]
    return (titled or candidates or [None])[0]


def snapshot() -> dict:
    ws = windows()
    mine = ours(ws)
    # Everything drawn by another app that is currently onscreen.
    others = [w for w in ws if not is_ours(w) and w["onscreen"] and w["bounds"][2] > 200]
    highest_other = max((w["layer"] for w in others), default=None)
    return {
        "ours": mine,
        "onscreen_other_windows": len(others),
        "highest_other_layer": highest_other,
        "above_everything": (
            mine is not None
            and highest_other is not None
            and mine["layer"] > highest_other
        ),
        "top_others": sorted(others, key=lambda w: -w["layer"])[:5],
    }


def describe_behaviour(value: int) -> str:
    names = [n for bit, n in BEHAVIOUR_BITS.items() if value & bit]
    return f"{value:#x} ({' | '.join(names) if names else 'none'})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", type=int, default=0, help="sample once a second for N seconds")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.watch:
        print(f"sampling for {args.watch}s — switch to a full-screen app now\n")
        print(f"{'t':>4} {'layer':>6} {'onscreen':>9} {'alpha':>6} {'others':>7} {'maxOther':>9} {'verdict':>9}")
        worst = True
        for t in range(args.watch):
            s = snapshot()
            m = s["ours"]
            if m is None:
                print(f"{t:>4} {'--':>6} {'MISSING':>9}")
                worst = False
            else:
                ok = s["above_everything"]
                worst &= bool(ok and m["onscreen"])
                print(
                    f"{t:>4} {m['layer']:>6} {str(m['onscreen']):>9} {m['alpha']:>6} "
                    f"{s['onscreen_other_windows']:>7} {str(s['highest_other_layer']):>9} "
                    f"{('ABOVE' if ok else 'below'):>9}"
                )
            time.sleep(1)
        print(f"\nresult: {'PASS — never dropped below another window' if worst else 'FAIL — see rows above'}")
        return 0 if worst else 1

    s = snapshot()
    if args.json:
        print(json.dumps(s, indent=2))
        return 0

    m = s["ours"]
    if m is None:
        print(f"{OURS[0]} has no onscreen window — is the app running?")
        return 1
    print(f"{OURS[0]}: layer={m['layer']} onscreen={m['onscreen']} alpha={m['alpha']} bounds={m['bounds']}")
    print(f"highest other onscreen layer: {s['highest_other_layer']} ({s['onscreen_other_windows']} windows)")
    print("verdict:", "ABOVE everything" if s["above_everything"] else "NOT above everything")
    print("\ntop other windows by layer:")
    for w in s["top_others"]:
        print(f"  layer={w['layer']:<4} {w['owner']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
