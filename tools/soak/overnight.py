#!/usr/bin/env python3
"""
Eight hours, and does the pet stay visible the whole time?

Two open questions in one run.

**TZX-78** wants memory flat over a workday with session eviction proven. The
existing soak in `tools/invariants/verify.py` measures that, and this reuses its
sampling rather than writing a second version.

**TZX-97** is the reason this exists in its current form. The pet sometimes does
not render at all — window at the right size and position, state machine correct,
nothing on screen — and six hypotheses died because every measurement was taken
*after* the symptom had gone. It cannot be reproduced on demand. So the plan is
to be measuring when it happens: sample visibility every couple of minutes for
eight hours and keep the evidence from any sample that fails.

`screencapture -l` captures the window by id, which is the only measurement in
this project that was never confounded — it does not care which Space is active,
what is behind the window, whether the pet is mid-walk, or whether the window
server counts it onscreen.

**Samples are written as they are taken.** The previous soak held everything in
memory and printed a summary at the end, so an interrupt at hour seven threw away
seven hours of data. That was noticed once and half-fixed by line-buffering
stdout; the samples themselves still evaporated. Here every sample is a line of
JSONL, flushed, and the summary is computed from the file — so a run killed at
any point is still a run that measured something.

Usage:
    caffeinate -is python3 tools/soak/overnight.py \\
        --binary packages/pet-core/src-tauri/target/release/agent-pet --hours 8

`caffeinate` matters: a sleeping display makes every visibility sample
meaningless, and the run would report a catastrophe that was only a screensaver.
Needs Screen Recording. macOS only.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "invariants"))
from verify import cpu_and_rss, process_tree  # noqa: E402

# The port the hooks already use. An earlier run took 48240 to stay out of the
# way, which meant the operator's hooks pointed at a dead 48200 for forty minutes
# and every tool call in their session printed two connection errors. A
# measurement tool that takes a different port does not avoid the integration, it
# removes it — and the pet is more interesting to measure while something real is
# driving it anyway.
DEFAULT_PORT = 48200
SOURCE = "claude-code"
# Alpha at or below this is not content. Matches tools/layout/paints.py.
BACKDROP = 8


def post(port: int, body: dict, timeout: float = 3.0) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/event/{SOURCE}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=timeout).read()


def health(port: int, timeout: float = 3.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def window_id() -> int | None:
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


def onscreen() -> bool:
    """What the window server thinks. Recorded alongside the pixels because the
    two disagreed for a whole day and the disagreement was the clue."""
    return any(
        w.get("kCGWindowOwnerName") in ("Agent Pet", "agent-pet")
        for w in (
            Quartz.CGWindowListCopyWindowInfo(
                Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
                Quartz.kCGNullWindowID,
            )
            or []
        )
    )


def visibility(keep_dir: Path, stamp: str, keep: bool = True) -> dict:
    """Capture the window by id and describe what is painted in it."""
    wid = window_id()
    if wid is None:
        return {"window": False}

    tmp = keep_dir / f"tmp-{stamp}.png"
    try:
        subprocess.run(
            ["screencapture", "-x", "-o", "-l", str(wid), str(tmp)],
            check=True,
            capture_output=True,
        )
        im = Image.open(tmp)
        if im.mode != "RGBA":
            return {"window": True, "error": f"mode {im.mode}"}
        a = im.getchannel("A")
        lo, hi = a.getextrema()
        content = sum(1 for p in a.get_flattened_data() if p > BACKDROP) / (im.width * im.height)
        painting = hi >= 200 and content >= 0.02
        if not painting:
            row = {
                "window": True,
                "painting": False,
                "alpha_lo": lo,
                "alpha_hi": hi,
                "content": round(content, 5),
            }
            if keep:
                # The whole point of the run. Keep it — a frame from the moment it
                # was wrong is worth more than any amount of reasoning afterwards.
                kept = keep_dir / f"invisible-{stamp}.png"
                tmp.replace(kept)
                row["evidence"] = str(kept)
            return row
        return {
            "window": True,
            "painting": True,
            "alpha_lo": lo,
            "alpha_hi": hi,
            "content": round(content, 5),
        }
    except Exception as e:  # a failed capture is data, not a crash
        return {"window": True, "error": f"{type(e).__name__}: {e}"}
    finally:
        tmp.unlink(missing_ok=True)


def summarise(path: Path, hours: float) -> int:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    samples = [r for r in rows if r.get("kind") == "sample"]
    # Checked before anything else, and fatal. The first run of this tool
    # recorded "the pet stopped answering after 1.7 min" and then printed "it
    # stayed up, stayed flat, and stayed visible", because the summary only ever
    # looked at sample rows. A soak that can pass while its subject is dead is
    # not a soak.
    died = [r for r in rows if r.get("kind") == "died"]
    for d in died:
        print(
            f"\nthe pet stopped answering after {d['after_seconds'] / 60:.1f} min "
            f"({d['sessions']} sessions): {d['error']}"
        )
        print(f"  its own output: {path.parent / 'pet.log'}")
    if len(samples) < 4:
        print(f"\nonly {len(samples)} samples — this is not a result")
        return 1

    span_h = (samples[-1]["t"] - samples[0]["t"]) / 3600 or hours
    head = samples[: max(2, len(samples) // 5)]
    tail = samples[-max(2, len(samples) // 5) :]
    first = sum(s["rss_mb"] for s in head) / len(head)
    last = sum(s["rss_mb"] for s in tail) / len(tail)
    per_hour = (last - first) / span_h if span_h else 0.0

    vis = [s for s in samples if s.get("window")]
    painting = [s for s in vis if s.get("painting")]
    duty = len(painting) / len(vis) if vis else 0.0
    invisible = [s for s in vis if s.get("painting") is False]
    dropped = max((s.get("dropped", 0) for s in samples), default=0)
    max_sessions = max((s.get("sessions", 0) for s in samples), default=0)
    disconnects = [s for s in samples if not s.get("connected")]

    print(f"\n{'=' * 62}")
    print(f"{len(samples)} samples over {span_h:.2f} h")
    print(f"memory      {first:.0f} -> {last:.0f} MB  ({per_hour:+.1f} MB/h)")
    print(f"visible     {duty:.1%} of {len(vis)} samples that had a window")
    print(f"sessions    peak {max_sessions}")
    print(f"events      {dropped} dropped")
    print(f"webview     {len(disconnects)} sample(s) with no connection")
    fp = next((r for r in rows if r.get("kind") == "first_paint"), None)
    if fp:
        print(
            f"first paint  {fp['seconds']:.1f} s after the webview connected"
            if fp.get("seconds") is not None
            else "first paint  never — the pet did not paint during warm-up"
        )
    hiccups = [r for r in rows if r.get("kind") == "hiccup"]
    if hiccups:
        print(f"hiccups     {len(hiccups)} slow request(s), pet alive each time")

    problems = []
    if fp and fp.get("seconds") is None:
        problems.append("the pet never painted a frame at all — TZX-97, from startup")
    for d in died:
        problems.append(
            f"the pet stopped answering after {d['after_seconds'] / 60:.1f} min "
            f"({d['sessions']} sessions): {d['error']}"
        )
    # Growth, not size: the WebKit floor is ~350 MB and no care changes it.
    if per_hour > 10.0:
        problems.append(f"memory grew {per_hour:+.1f} MB/h")
    if per_hour < -20.0:
        print("            (a large decline means it never reached steady state)")
    if duty < 0.95:
        problems.append(f"the pet was only visible in {duty:.1%} of samples — TZX-97")
    if dropped:
        problems.append(f"{dropped} events were dropped")
    if disconnects:
        problems.append(f"the webview was disconnected in {len(disconnects)} sample(s)")
    # Eviction: the registry is supposed to bound itself. Sessions are created
    # about every five seconds, so an unbounded registry is obvious over hours.
    if max_sessions > 200:
        problems.append(f"sessions peaked at {max_sessions} — eviction is not working")

    if invisible:
        print(f"\n{len(invisible)} sample(s) caught the pet not painting:")
        for s in invisible[:10]:
            print(
                f"  t+{(s['t'] - samples[0]['t']) / 60:6.1f} min  "
                f"alpha {s['alpha_lo']},{s['alpha_hi']}  content {s['content']:.2%}  "
                f"onscreen={s.get('onscreen')}  {s.get('evidence', '')}"
            )
        print("  ^ this is the TZX-97 evidence the investigation lacked")

    if problems:
        print("\nFAIL")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\nit stayed up, stayed flat, and stayed visible")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--hours", type=float, default=8.0)
    ap.add_argument("--sample-seconds", type=float, default=120.0)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument(
        "--warmup",
        type=float,
        default=45.0,
        help="seconds to allow for the first painted frame before sampling starts",
    )
    ap.add_argument("--out", default="artifacts/soak")
    args = ap.parse_args()

    binary = Path(args.binary).resolve()
    if not binary.exists():
        raise SystemExit(f"{binary} does not exist — `pnpm tauri build --no-bundle` first")
    if health(args.port):
        raise SystemExit(f"something is already listening on {args.port}; stop it first")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log = out / "samples.jsonl"

    pet_log = (out / "pet.log").open("w", buffering=1)
    proc = subprocess.Popen(
        [str(binary)],
        stdout=pet_log,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PET_PORT": str(args.port)},
    )
    started = time.time()
    fh = log.open("w", buffering=1)  # line buffered: a killed run keeps its data

    def record(row: dict) -> None:
        fh.write(json.dumps(row) + "\n")
        fh.flush()
        os.fsync(fh.fileno())

    try:
        for _ in range(120):
            h = health(args.port)
            if h and h["webview"]["connected"]:
                break
            if proc.poll() is not None:
                raise SystemExit(f"the pet exited before it was ready ({proc.returncode})")
            time.sleep(0.5)
        else:
            raise SystemExit("the pet never reported a connected webview")

        record({"kind": "start", "t": started, "hours": args.hours, "binary": str(binary)})
        print(f"pet up on {args.port}; {args.hours} h, sampling every {args.sample_seconds:.0f} s")
        print("your own sessions reach this pet too — their events are in the counts")

        # Time to first painted frame, measured rather than assumed.
        #
        # `report_ready` fires when the webview's adapter registry is up, which is
        # before anything has been composited — so the first sample used to land on
        # an empty window and report a TZX-97 hit on every single run. A tool that
        # cries wolf at t+0 every time trains you to ignore the one signal it exists
        # to produce, which is worse than not having it.
        #
        # So this waits for the first paint and records how long it took. A blind
        # sleep would hide a pet that never paints at all; this reports it.
        paint_started = time.time()
        first_paint = None
        while time.time() - paint_started < args.warmup:
            # keep=False: a frame that has not painted *yet* is the expected
            # answer here, not evidence of anything.
            v = visibility(out, "warmup", keep=False)
            if v.get("painting"):
                first_paint = time.time() - paint_started
                break
            time.sleep(2)
        record({"kind": "first_paint", "t": time.time(), "seconds": first_paint})
        print(
            f"  first painted frame after {first_paint:.1f} s"
            if first_paint is not None
            else f"  NOTHING PAINTED in {args.warmup:.0f} s — TZX-97 from the very start"
        )
        print(f"samples -> {log}\n")

        end = started + args.hours * 3600
        session = 0
        next_sample = time.time()
        while time.time() < end:
            session += 1
            sid = f"soak-{session}"
            cwd = f"/w/project-{session % 5}"
            try:
                for body in (
                    {"hook_event_name": "SessionStart", "session_id": sid, "cwd": cwd},
                    {"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": cwd},
                    {
                        "hook_event_name": "PreToolUse",
                        "session_id": sid,
                        "cwd": cwd,
                        "tool_name": "Bash",
                        "tool_input": {"command": f"pnpm test --filter pkg-{session}"},
                    },
                    {
                        "hook_event_name": "PostToolUse",
                        "session_id": sid,
                        "cwd": cwd,
                        "tool_name": "Bash",
                    },
                    {"hook_event_name": "Stop", "session_id": sid, "cwd": cwd},
                ):
                    post(args.port, body)
            except Exception as e:
                elapsed = time.time() - started
                # One slow POST is not a death, and the difference matters.
                # `screencapture` briefly stalls the app, so the first request
                # after a visibility sample can exceed the 3 s timeout while the
                # pet is perfectly alive — the smoke run reported exactly that as
                # "the pet stopped answering", and a separate 200-event check
                # then showed it surviving with a worst round trip of 25 ms.
                #
                # So ask /health, which is the question that distinguishes them.
                # An instrument that cannot tell "I disturbed it" from "it died"
                # will report the wrong bug for eight hours.
                alive = health(args.port, timeout=8.0)
                if alive:
                    record(
                        {
                            "kind": "hiccup",
                            "t": time.time(),
                            "after_seconds": round(elapsed, 1),
                            "sessions": session,
                            "error": f"{type(e).__name__}: {e}",
                        }
                    )
                    print(f"  t+{elapsed / 60:6.1f} min  slow request, pet still alive", flush=True)
                    continue
                record(
                    {
                        "kind": "died",
                        "t": time.time(),
                        "after_seconds": round(elapsed, 1),
                        "sessions": session,
                        "error": f"{type(e).__name__}: {e}",
                    }
                )
                print(
                    f"\nthe pet stopped answering after {elapsed / 60:.1f} min "
                    f"({session} sessions): {type(e).__name__} {e}"
                )
                break

            if time.time() >= next_sample:
                next_sample = time.time() + args.sample_seconds
                stamp = time.strftime("%H%M%S")
                h = health(args.port) or {}
                # Re-read: WebKit's helper processes come and go, and a tree
                # captured once slowly stops describing the app.
                _, rss = cpu_and_rss(process_tree(proc.pid))
                row = {
                    "kind": "sample",
                    "t": time.time(),
                    "rss_mb": round(rss, 1),
                    "sessions": h.get("webview", {}).get("sessions", 0),
                    "connected": bool(h.get("webview", {}).get("connected")),
                    "delivered": h.get("events", {}).get("delivered", 0),
                    "dropped": h.get("events", {}).get("dropped", 0),
                    "focused": h.get("webview", {}).get("focusedState", ""),
                    "onscreen": onscreen(),
                    **visibility(out, stamp),
                }
                record(row)
                mark = "." if row.get("painting") else "!"
                print(
                    f"  t+{(row['t'] - started) / 60:6.1f} min  {row['rss_mb']:6.1f} MB  "
                    f"sessions {row['sessions']:3d}  {row.get('content', 0):6.2%} painted "
                    f"{mark}",
                    flush=True,
                )

            time.sleep(5)
    except KeyboardInterrupt:
        print("\ninterrupted — summarising what was measured so far")
    finally:
        record({"kind": "end", "t": time.time()})
        fh.close()
        pet_log.close()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    return summarise(log, args.hours)


if __name__ == "__main__":
    sys.exit(main())
