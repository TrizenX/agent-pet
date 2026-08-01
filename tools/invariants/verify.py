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
    on = latency_samples(port, 200)
    median = statistics.median(on) if on else float("inf")
    p99 = statistics.quantiles(on, n=100)[98] if len(on) > 10 else median
    # A hook is an HTTP round trip on loopback. Anything past a millisecond
    # means the handler is doing work it should not be.
    ok = median < 1.0
    return Check(
        "a hook round-trip costs well under a millisecond",
        "I2",
        ok,
        f"median {median:.3f} ms, p99 {p99:.3f} ms over {len(on)} requests",
        {"median_ms": round(median, 4), "p99_ms": round(p99, 4), "n": len(on)},
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

        # The client's own timeout stands in for the hook's `timeout: 2`.
        ok = waited <= 2_600
        return Check(
            "a hung pet still bounds the agent's wait",
            "I2",
            ok,
            f"agent waited {waited:.0f} ms before the hook timeout would fire",
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

def process_tree(root_pid: int) -> dict[int, str]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spike-overlay"))
    from measure_cpu import pids_for  # noqa: E402

    return pids_for(root_pid, "agent-pet")


def cpu_and_rss(pids) -> tuple[float, float]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "spike-overlay"))
    from measure_cpu import cpu_seconds, rss_kb  # noqa: E402

    return cpu_seconds(pids), rss_kb(pids) / 1024


def check_i6(root_pid: int, seconds: float) -> Check:
    pids = process_tree(root_pid)
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
        f"{pct:.3f} % of one core over {seconds:.0f} s, RSS {r0:.0f} -> {r1:.0f} MB",
        {"cpu_percent": round(pct, 4), "rss_start_mb": round(r0), "rss_end_mb": round(r1)},
    )


# ------------------------------------------------------------------- multi-session

def check_multi_session(port: int) -> Check:
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
    sessions = h.get("webview", {}).get("sessions", 0)
    received = h.get("events", {}).get("received", 0)
    ok = sessions >= 2
    detail = f"{sessions} live session(s) after interleaving two"
    if not ok and received > 0:
        detail += f" — {received} events reached the shell, so they are being dropped downstream"
    return Check(
        "concurrent sessions are tracked separately",
        "§8",
        ok,
        detail,
        {"sessions": sessions, "received": received, "since": now},
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
            post(port, f"/event/{SOURCE}", json.dumps(body).encode())
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

    # A real leak on a 350 MB baseline shows up as tens of MB an hour. Anything
    # under 10 MB/h is inside the noise of a garbage-collected runtime.
    ok = per_hour < 10.0
    return Check(
        "memory stays flat over a long run",
        "M2 soak",
        ok,
        f"{first:.0f} -> {last:.0f} MB over {minutes:.0f} min ({per_hour:+.1f} MB/h), "
        f"{session} sessions",
        {"first_mb": round(first), "last_mb": round(last),
         "mb_per_hour": round(per_hour, 2), "sessions": session,
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
        for fn in (check_i1, check_browser_lockout, check_i2_running, check_multi_session):
            c = fn(args.port)
            checks.append(c)
            print(f"[{'PASS' if c.passed else 'FAIL'}] {c.invariant:6} {c.name}\n         {c.detail}")

        c = check_i6(proc.pid, args.idle_seconds)
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
