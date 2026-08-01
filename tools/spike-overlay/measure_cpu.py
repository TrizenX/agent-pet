#!/usr/bin/env python3
"""
M0 Spike C — what does the overlay cost while it sits there?

Invariant I6 says idle cost is zero: while `sleeping` the app performs no
animation and no repaints. A transparent, always-on-top window that composites
continuously is the classic way to drain a laptop battery, and battery drain is
the most common reason overlay apps get uninstalled.

Method: sample *cumulative CPU time* for the whole process tree at the start and
end of a window, then divide by wall time. That is a true average over the
interval, not a `%CPU` snapshot (which on macOS is an average since process
start and useless for this) and not a sampled estimate.

The whole tree matters: a Tauri app is the Rust process plus WebKit's
`com.apple.WebKit.WebContent` and `Networking` helpers, and the compositing cost
lands in WebContent, not in our binary.

Usage:
    python3 measure_cpu.py --binary … --minutes 5
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

# WebKit helpers are not children of our process on macOS — they are spawned by
# launchd — so the tree has to be found by name as well as by parentage.
HELPER_HINTS = ("WebKit.WebContent", "WebKit.Networking", "WebKit.GPU")


def pids_for(root_pid: int, binary_name: str) -> dict[int, str]:
    """Our process, its descendants, and the WebKit helpers it is using."""
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,comm="], capture_output=True, text=True
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))

    found = {p: c for p, pp, c in rows if p == root_pid}
    # Walk descendants breadth-first.
    changed = True
    while changed:
        changed = False
        for p, pp, c in rows:
            if pp in found and p not in found:
                found[p] = c
                changed = True

    # WebKit helpers, attributed to us only if they appeared with the app.
    for p, pp, c in rows:
        if any(h in c for h in HELPER_HINTS) and p not in found:
            found[p] = c
    return found


def parse_cputime(field: str) -> float:
    """macOS `ps -o cputime` prints [[HH:]MM:]SS.ss, not plain seconds."""
    parts = field.strip().split(":")
    try:
        nums = [float(x) for x in parts]
    except ValueError:
        raise ValueError(f"unparseable cputime {field!r}")
    seconds = 0.0
    for n in nums:
        seconds = seconds * 60 + n
    return seconds


def cpu_seconds(pids) -> float:
    """
    Cumulative CPU seconds across the given pids.

    Uses `cputime`, not `cputimes`: the latter is a Linux keyword that macOS ps
    rejects outright. The first version of this script used it, ps wrote its
    error to stderr, and the parser silently returned 0.0 — producing a
    confident 0.000% for an animating window. Hence the sanity check in main().
    """
    if not pids:
        return 0.0
    proc = subprocess.run(
        ["ps", "-o", "cputime=", "-p", ",".join(str(p) for p in pids)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(f"ps failed: {proc.stderr.strip() or 'no output'}")
    return sum(parse_cputime(line) for line in proc.stdout.splitlines() if line.strip())


def rss_kb(pids) -> int:
    if not pids:
        return 0
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", ",".join(str(p) for p in pids)],
        capture_output=True,
        text=True,
    ).stdout
    return sum(int(x) for x in out.split() if x.isdigit())


def measure(binary: Path, static: bool, minutes: float, settle: float) -> dict:
    # PET_STATIC was removed once the real renderer landed: `sleeping` is now
    # reached through the state machine, so the flag would have been a second,
    # divergent path to the thing being measured. Idle cost is now measured by
    # leaving the app alone, which is also what a user does.
    env = dict(os.environ)
    proc = subprocess.Popen(
        [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    label = "static (sleeping)" if static else "animating"
    try:
        time.sleep(settle)  # let startup and first paint finish
        pids = pids_for(proc.pid, binary.name)
        if not pids:
            raise RuntimeError("no process tree found")

        t0, c0, rss0 = time.time(), cpu_seconds(pids), rss_kb(pids)
        time.sleep(minutes * 60)
        t1, c1, rss1 = time.time(), cpu_seconds(pids), rss_kb(pids)

        wall = t1 - t0
        pct = (c1 - c0) / wall * 100.0
        return {
            "mode": label,
            "static": static,
            "pids": len(pids),
            "processes": sorted(set(pids.values())),
            "wall_seconds": round(wall, 1),
            "cpu_seconds": round(c1 - c0, 2),
            "cpu_percent_of_one_core": round(pct, 3),
            "rss_start_mb": round(rss0 / 1024, 1),
            "rss_end_mb": round(rss1 / 1024, 1),
            "rss_growth_mb": round((rss1 - rss0) / 1024, 2),
        }
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True, type=Path)
    ap.add_argument("--minutes", type=float, default=5.0)
    ap.add_argument("--settle", type=float, default=8.0)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    print(f"measuring {args.minutes:g} min per mode, whole process tree\n")
    results = []
    for static in (False, True):
        r = measure(args.binary, static, args.minutes, args.settle)
        results.append(r)
        print(
            f"{r['mode']:<20} cpu={r['cpu_percent_of_one_core']:>7.3f}%  "
            f"({r['cpu_seconds']:.2f}s over {r['wall_seconds']:.0f}s, {r['pids']} procs)  "
            f"rss {r['rss_start_mb']:.1f} -> {r['rss_end_mb']:.1f} MB"
        )

    animating, static = results[0], results[1]

    # A probe that cannot detect anything must not be allowed to report success.
    # An animating webview consuming exactly zero CPU means the measurement is
    # broken, not that the animation is free.
    if animating["cpu_seconds"] <= 0.0:
        print("\nMEASUREMENT INVALID: the animating case consumed 0.00s of CPU.")
        print("That is not plausible; the probe is not reading CPU time. Fix it before")
        print("believing any verdict below.")
        return 2

    print("\n--- I6: while sleeping, no animation and no repaints ---")
    verdict_ok = static["cpu_percent_of_one_core"] < 0.5
    print(
        f"static {static['cpu_percent_of_one_core']:.3f}% vs animating "
        f"{animating['cpu_percent_of_one_core']:.3f}%  ->  "
        f"{'PASS' if verdict_ok else 'FAIL'} (threshold 0.5% of one core)"
    )
    if animating["cpu_percent_of_one_core"] > 5.0:
        print("NOTE: the animating cost is high enough to matter on battery; "
              "consider lowering fps or pausing when unfocused.")

    payload = {"results": results, "i6_pass": verdict_ok}
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, indent=2))
        print(f"results -> {args.out}")
    return 0 if verdict_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
