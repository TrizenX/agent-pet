#!/usr/bin/env python3
"""
M2 — measure the hard invariants against a running pet.

Spec §2 lists seven invariants and §11.4 assigns each an owning test. The unit
tests prove the code does what it was written to do; this proves the assembled
application does, against a real HTTP endpoint and a real process tree.

The two that matter most cannot be unit-tested at all, because both are claims
about the *agent*, not about us:

  I1  the pet never changes agent behaviour  — every response must be 204 with
      an empty body, including for input we cannot parse
  I2  the pet never slows the agent          — and, crucially, a pet that has
      hung must not either

Usage:
    python3 verify.py --binary path/to/agent-pet            # full run
    python3 verify.py --binary … --soak-minutes 480         # the M2 soak
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

DEFAULT_PORT = 48200

# Filled in from /health at startup. Hardcoding an agent id here was the first
# version's bug: the suite posted to a source no adapter claimed, every event
# was dropped as `unknown-source`, and it still reported 7/8 passing — grading
# an app that had received nothing. /health lists the adapters precisely so a
# tool does not have to guess.
SOURCE = "unknown"


@dataclass
class Check:
    name: str
    invariant: str
    passed: bool
    detail: str
    data: dict = field(default_factory=dict)


def post(port: int, path: str, body: bytes, headers: dict[str, str] | None = None,
         timeout: float = 5.0) -> tuple[int, bytes]:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=body, method="POST",
        headers={"content-type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return json.load(r)
    except Exception:
        return None


# --------------------------------------------------------------------------- I1

def check_i1(port: int) -> Check:
    """Every response a hook can provoke must be 204 with an empty body."""
    cases = {
        "ordinary event": b'{"hook_event_name":"Stop","session_id":"i1"}',
        "unparseable": b"not json at all",
        "empty": b"",
        "truncated": b"{",
        "wrong shape": b"[1,2,3]",
        "null": b"null",
        "deeply nested": b'{"a":' + b'{"b":' * 50 + b"1" + b"}" * 50 + b"}",
        "200 KB payload": b'{"stdout":"' + b"x" * 200_000 + b'"}',
    }
    bad = []
    for name, body in cases.items():
        status, out = post(port, f"/event/{SOURCE}", body)
        if status != 204 or out != b"":
            bad.append(f"{name}: {status}, {len(out)} bytes")

    return Check(
        "every hook response is 204 with an empty body",
        "I1",
        not bad,
        "all inputs answered 204/0 bytes" if not bad else "; ".join(bad),
        {"cases": len(cases)},
    )


# --------------------------------------------------------------------------- I2

def latency_samples(port: int, n: int, timeout: float = 5.0) -> list[float]:
    """Round-trip time on a reused connection, so the number is ours and not curl's."""
    import http.client

    body = json.dumps(
        {"hook_event_name": "PreToolUse", "session_id": "lat", "tool_name": "Bash"}
    ).encode()
    samples = []
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    for _ in range(n):
        t = time.perf_counter()
        try:
            conn.request("POST", f"/event/{SOURCE}", body,
                         {"content-type": "application/json"})
            conn.getresponse().read()
        except Exception:
            conn.close()
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
            continue
        samples.append((time.perf_counter() - t) * 1000)
    conn.close()
    return samples


def check_i2_running(port: int) -> Check:
    requested = 200
    on = latency_samples(port, requested)
    median = statistics.median(on) if on else float("inf")
    p99 = statistics.quantiles(on, n=100)[98] if len(on) > 10 else median

    # A median over the handful of requests that happened to survive is not a
    # median. A partially wedged pet could answer five of two hundred quickly
    # and score better than a healthy one, which is the wrong way round.
    delivered = len(on) / requested
    ok = median < 1.0 and delivered >= 0.99

    detail = f"median {median:.3f} ms, p99 {p99:.3f} ms over {len(on)}/{requested} requests"
    if delivered < 0.99:
        detail += f" — only {delivered:.0%} answered, so the median is not representative"
    return Check(
        "a hook round-trip costs well under a millisecond",
        "I2",
        ok,
        detail,
        {"median_ms": round(median, 4), "p99_ms": round(p99, 4),
         "n": len(on), "requested": requested},
    )


def check_i2_dead(port: int) -> Check:
    """A pet that is not running must cost nothing."""
    samples = latency_samples(port, 50)
    # Connection refused on loopback returns immediately; every request fails,
    # so `samples` is empty and the wall time is what we actually measure.
    t = time.perf_counter()
    latency_samples(port, 50)
    elapsed = (time.perf_counter() - t) * 1000 / 50
    ok = elapsed < 5.0 and not samples
    return Check(
        "a stopped pet costs the agent nothing",
        "I2",
        ok,
        f"{elapsed:.3f} ms per refused connection",
        {"per_request_ms": round(elapsed, 4)},
    )


def check_i2_hung(port: int, binary: Path) -> Check:
    """
    The case that actually matters.

    A stopped pet is refused instantly, which is easy. A *hung* one is what
    would make the agent wait, and the hook timeout is the only thing standing
    between the user and a two-second pause on every tool call.
    """
    proc = subprocess.Popen([str(binary)], env=dict(os.environ),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            if health(port):
                break
            time.sleep(0.5)
        else:
            return Check("a hung pet still bounds the agent's wait", "I2", False,
                         "pet never became healthy", {})

        os.kill(proc.pid, signal.SIGSTOP)
        time.sleep(0.5)
        t = time.perf_counter()
        try:
            post(port, f"/event/{SOURCE}", b"{}", timeout=2.5)
        except Exception:
            pass
        waited = (time.perf_counter() - t) * 1000
        os.kill(proc.pid, signal.SIGCONT)

        # This is our client's timeout, not the agent's hook runner. It is set
        # slightly above the hook's declared `timeout: 2` so the measurement
        # shows the pet does not respond at all while hung — the real hook
        # would give up ~500 ms sooner. What is proven here is that the wait is
        # bounded by a timeout rather than by the pet, not the exact bound.
        ok = waited <= 2_600
        return Check(
            "a hung pet still bounds the agent's wait",
            "I2",
            ok,
            f"no response for {waited:.0f} ms (our 2.5 s client timeout; the hook's "
            f"own 2 s would fire sooner)",
            {"waited_ms": round(waited)},
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------- I1 again: guard

def check_browser_lockout(port: int) -> Check:
    refused = []
    for header in ("origin", "sec-fetch-site", "sec-fetch-mode"):
        status, _ = post(port, f"/event/{SOURCE}", b"{}", {header: "https://evil.example"})
        refused.append((header, status))
    ok = all(s == 403 for _, s in refused)
    return Check(
        "browser-originated requests are refused",
        "§10",
        ok,
        ", ".join(f"{h}={s}" for h, s in refused),
        {},
    )


# --------------------------------------------------------------------------- I6

# WebKit helpers that were already running before the pet started. Anything in
# here belongs to some other app and must not be charged to us.
PREEXISTING_WEBKIT: set[int] = set()


def process_tree(root_pid: int) -> dict[int, str]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spike-overlay"))
    from measure_cpu import pids_for  # noqa: E402

    return pids_for(root_pid, "agent-pet", PREEXISTING_WEBKIT)


def cpu_and_rss(pids) -> tuple[float, float]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spike-overlay"))
    from measure_cpu import cpu_seconds, rss_kb  # noqa: E402

    return cpu_seconds(pids), rss_kb(pids) / 1024


def check_i6(root_pid: int, seconds: float, settle: float = 15.0) -> Check:
    """
    Idle cost, measured on a pet nothing has been sent to.

    This has to run *before* the load checks, not after. Placed last, it caught
    the app unwinding from 241 events — RSS falling ~90 MB across a window
    labelled "idle" and CPU reading 2 % against an isolated truth of 0.1 %.
    Recovery-after-load is a real thing to measure, but it is not this thing,
    and calling it idle made the number wrong by twentyfold.
    """
    pids = process_tree(root_pid)
    time.sleep(settle)
    c0, r0 = cpu_and_rss(pids)
    t0 = time.time()
    time.sleep(seconds)
    c1, r1 = cpu_and_rss(pids)
    pct = (c1 - c0) / (time.time() - t0) * 100
    ok = pct < 0.5
    return Check(
        "an idle pet costs approximately nothing",
        "I6",
        ok,
        f"{pct:.3f} % of one core over {seconds:.0f} s "
        f"(after {settle:.0f} s settling), RSS {r0:.0f} -> {r1:.0f} MB",
        {"cpu_percent": round(pct, 4), "rss_start_mb": round(r0), "rss_end_mb": round(r1)},
    )


# ------------------------------------------------------------------- multi-session

def check_multi_session(port: int) -> Check:
    """
    Not "are there two sessions?" — that passes trivially, because the checks
    before this one already created sessions of their own and nothing evicts
    them for ten minutes. It passed even when the harness was posting to a
    source no adapter claimed.

    The reviewable claim is the focus policy: an approval outranks a session
    that is more recently active, and the pet names that session's project.
    """
    before = (health(port) or {}).get("webview", {}).get("sessions", 0)
    now = int(time.time() * 1000)
    post(port, f"/event/{SOURCE}", json.dumps({
        "hook_event_name": "PermissionRequest", "session_id": "ms-a",
        "cwd": "/w/acme-api", "tool_name": "Bash"}).encode())
    for i in range(20):
        post(port, f"/event/{SOURCE}", json.dumps({
            "hook_event_name": "PreToolUse", "session_id": "ms-b",
            "cwd": "/w/other-repo", "tool_name": "Bash"}).encode())
        post(port, f"/event/{SOURCE}", json.dumps({
            "hook_event_name": "PostToolUse", "session_id": "ms-b",
            "cwd": "/w/other-repo", "tool_name": "Bash"}).encode())
    time.sleep(1.5)

    h = health(port) or {}
    w = h.get("webview", {})
    sessions = w.get("sessions", 0)
    state = w.get("focusedState", "")
    project = w.get("focusedProject", "")

    grew = sessions >= before + 2
    # ms-b posted 40 events after ms-a's approval, so recency alone would show
    # other-repo. Showing acme-api is the policy working.
    correct_focus = state == "waiting_approval" and project == "acme-api"
    ok = grew and correct_focus

    detail = (
        f"{before} -> {sessions} sessions; focus is {state or '(none)'} "
        f"on {project or '(none)'}"
    )
    if not grew:
        detail += " — the two new sessions were not created"
    elif not correct_focus:
        detail += " — recency beat the approval, which is the bug §8 exists to prevent"
    return Check(
        "an approval outranks a more recently active session",
        "§8",
        ok,
        detail,
        {"before": before, "after": sessions, "state": state, "project": project, "since": now},
    )


# -------------------------------------------------------------------------- soak

def soak(port: int, root_pid: int, minutes: float) -> Check:
    """
    Memory flat over a long run.

    The criterion is *flat*, not *small*: the WebKit floor is ~350 MB and no
    amount of care changes that. What would matter is a slope.
    """
    pids = process_tree(root_pid)
    samples: list[tuple[float, float]] = []
    end = time.time() + minutes * 60
    session = 0
    while time.time() < end:
        # A workday's shape: sessions appear, do some work, and are abandoned.
        session += 1
        sid = f"soak-{session}"
        for body in (
            {"hook_event_name": "SessionStart", "session_id": sid, "cwd": "/w/p"},
            {"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": "/w/p"},
            {"hook_event_name": "PreToolUse", "session_id": sid, "cwd": "/w/p", "tool_name": "Bash"},
            {"hook_event_name": "PostToolUse", "session_id": sid, "cwd": "/w/p", "tool_name": "Bash"},
            {"hook_event_name": "Stop", "session_id": sid, "cwd": "/w/p"},
        ):
            try:
                post(port, f"/event/{SOURCE}", json.dumps(body).encode())
            except Exception as e:
                # The pet died mid-soak. That is the single most interesting
                # thing a soak can discover, and it used to arrive as a Python
                # traceback — a crash in the measuring instrument, reported as
                # if the instrument were the subject. Say what happened, how far
                # in, and fail.
                secs = time.time() - (end - minutes * 60)
                lasted = f"{secs:.0f} s" if secs < 90 else f"{secs / 60:.1f} min"
                return Check(
                    "memory stays flat over a long run", "M2 soak", False,
                    f"the pet stopped answering after {lasted} of {minutes} min "
                    f"({session} sessions in): {type(e).__name__} {e}",
                    {"seconds_survived": round(secs, 1), "sessions": session},
                )
        _, rss = cpu_and_rss(pids)
        samples.append((time.time(), rss))
        time.sleep(5)

    if len(samples) < 4:
        return Check("memory stays flat over a long run", "M2 soak", False,
                     "not enough samples", {})

    first = statistics.mean(r for _, r in samples[: max(2, len(samples) // 5)])
    last = statistics.mean(r for _, r in samples[-max(2, len(samples) // 5):])
    growth = last - first
    hours = minutes / 60
    per_hour = growth / hours if hours else growth

    # `< 10.0` is not a flatness check, it is a not-growing check, and a
    # review caught it passing a -738 MB/h decline as "flat". Growth is the
    # thing that matters, so it stays tightly bounded; a large decline is not a
    # failure but it does mean the run never reached steady state, and saying
    # so is more useful than a green tick.
    growing = per_hour > 10.0
    settling = per_hour < -20.0
    ok = not growing
    verdict = (
        "still settling — not a steady-state measurement"
        if settling
        else "flat" if abs(per_hour) <= 10.0 else "growing"
    )
    return Check(
        "memory does not grow over a long run",
        "M2 soak",
        ok,
        f"{first:.0f} -> {last:.0f} MB over {minutes:.0f} min ({per_hour:+.1f} MB/h) — {verdict}, "
        f"{session} sessions",
        {"first_mb": round(first), "last_mb": round(last),
         "mb_per_hour": round(per_hour, 2), "verdict": verdict, "sessions": session,
         "minutes": minutes, "samples": len(samples)},
    )


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True, type=Path)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--idle-seconds", type=float, default=60)
    ap.add_argument("--soak-minutes", type=float, default=0,
                    help="0 skips the soak; M2 asks for 480")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    if health(args.port):
        print(f"Something is already listening on {args.port}. Stop it first.")
        return 2

    # Snapshot before launching: every WebKit helper alive now belongs to
    # something else, and charging a busy browser to the pet turned a 0.1 %
    # idle measurement into 12 %.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spike-overlay"))
    from measure_cpu import webkit_pids  # noqa: E402

    PREEXISTING_WEBKIT.update(webkit_pids())

    proc = subprocess.Popen([str(args.binary)], env=dict(os.environ),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    checks: list[Check] = []
    try:
        # Two separate waits, because they are two separate things. The Rust
        # server answers /health within a second; the webview needs several
        # more to boot and report in. Checking them together races, and the
        # race looks exactly like a broken frontend.
        for _ in range(60):
            if health(args.port):
                break
            time.sleep(0.5)
        else:
            print("pet never became healthy")
            return 2

        for _ in range(60):
            h = health(args.port) or {}
            if h.get("webview", {}).get("connected"):
                break
            time.sleep(0.5)

        # A shell with no frontend answers /health, serves 204s and measures
        # beautifully — while tracking no sessions and rendering nothing. The
        # first run of this suite did exactly that and reported 7/8 passing.
        # Spike C's lesson again: a harness that cannot tell it is measuring
        # nothing must refuse to report.
        h = health(args.port) or {}
        if not h.get("webview", {}).get("connected"):
            print("The pet is listening but its webview is not connected.")
            print("In a debug build the shell loads the Vite dev server, so `pnpm dev:vite`")
            print("has to be running. Measuring now would grade an empty shell.")
            return 2

        adapters = h.get("webview", {}).get("adapters") or []
        if not adapters:
            print("The webview reports no adapters, so every event would be dropped as")
            print("`unknown-source` and every measurement would be of an app doing nothing.")
            return 2
        global SOURCE
        SOURCE = adapters[0]

        print(f"pet is up, webview connected, adapter `{SOURCE}`\n")

        # Idle first, while nothing has been sent to the pet. Order is
        # load-bearing: run last, this measured the app unwinding from 241
        # events and read 2 % against an isolated truth of 0.1 %, then read
        # 0.044 % on the next run purely because the collector happened to be
        # quiet. A measurement that swings twentyfold on scheduling luck is not
        # a measurement.
        c = check_i6(proc.pid, args.idle_seconds)
        checks.append(c)
        print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")

        for fn in (check_i1, check_browser_lockout, check_i2_running, check_multi_session):
            c = fn(args.port)
            checks.append(c)
            print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")

        if args.soak_minutes > 0:
            print(f"\nsoaking for {args.soak_minutes:g} min...")
            c = soak(args.port, proc.pid, args.soak_minutes)
            checks.append(c)
            print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1)

    c = check_i2_dead(args.port)
    checks.append(c)
    print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")

    c = check_i2_hung(args.port, args.binary)
    checks.append(c)
    print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")

    failed = [c for c in checks if not c.passed]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} passed")
    for c in failed:
        print(f"  FAILED  {c.invariant} {c.name}: {c.detail}")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps([asdict(c) for c in checks], indent=2))
        print(f"results -> {args.out}")

    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
