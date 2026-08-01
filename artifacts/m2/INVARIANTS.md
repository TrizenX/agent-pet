# M2 — invariant verification

**Date:** 2026-08-02 · **Host:** macOS 25.5.0, Apple silicon, debug build

```sh
pnpm --filter @agent-pet/pet-core dev:vite &
python3 tools/invariants/verify.py \
  --binary packages/pet-core/src-tauri/target/debug/agent-pet \
  --idle-seconds 45 --soak-minutes 6 --out artifacts/m2/invariants.json
```

The unit tests prove the code does what it was written to do. This proves the assembled application does — and the two invariants that matter most cannot be unit-tested at all, because both are claims about the *agent* rather than about us.

---

## What is and is not covered

Eight checks, not eight invariants. §2 lists seven; this suite exercises **I1, I2 and I6**, plus §8's focus policy and §10's guard.

**I3, I4 and I7 are not in it.** I3 (preemption) and I4 (no terminal state) are covered by 103 unit tests on the state machine, and I7 by the protocol's own tests — but nothing here checks them against the running app, and the one real-world trigger for the `exhausted` path still has no recorded fixture (TZX-63). "8/8" is a count of checks, not a claim of completeness.

## Result: 8/8

| | Check | Result |
| :-- | :-- | :-- |
| **I6** | idle cost, before anything is sent | **0.022 %** of one core, RSS 278 → 278 MB |
| **I1** | every response `204`, empty body | 8 shapes — ordinary, unparseable, empty, truncated, wrong-shape, `null`, 50-deep, 200 KB |
| §10 | browser requests refused | `origin` / `sec-fetch-site` / `sec-fetch-mode` → `403` |
| **I2** | round-trip | median 0.164 ms, p99 0.439 ms, **200/200 answered** |
| §8 | an approval outranks a more recent session | 2 → 4 sessions; focus `waiting_approval` on `acme-api` |
| soak | memory does not grow | 330 → 263 MB over 6 min, 72 sessions — *still settling* |
| **I2** | stopped pet | 0.113 ms per refused connection |
| **I2** | **hung pet** | no response for 2503 ms, then our client gives up |

### The hung-pet case is the one worth having

A *stopped* pet is easy — loopback refuses in a tenth of a millisecond. A **hung** one is what would actually make the agent wait, measured by `SIGSTOP`-ing the process mid-flight.

Careful about what this proves: 2503 ms is **our client's** 2.5 s timeout, deliberately set just above the hook's declared 2 s. It shows the pet does not respond at all while hung, so the wait is bounded by a timeout rather than by the pet. The real hook would give up ~500 ms sooner. It does not exercise the agent's own hook runner.

### On the numbers that moved

**Latency 0.164 ms.** M1's acceptance reported 7.63 ms for the same thing; that was almost entirely `curl` startup, and the delta it computed happened to be right for the wrong reason.

**Soak reports "still settling", not "flat".** RSS falls because the atlas decode and React boot peak early. The check bounds *growth* tightly and says so; it does not pretend a −672 MB/h slope is flat.

---

## The suite found two product bugs — and four in itself

### In the product

**`/health` reported `sessions: 0` permanently.** The frontend called `report_ready` once at mount, when the count was necessarily zero, and never again. No unit test could have caught it: the registry was right, the endpoint was right, only the wire between them was wrong.

**A session count cannot verify the focus policy.** Asking "are there two sessions?" passes even if both collapsed into one wrong state. `/health` now reports the focused state and project, so the check is the reviewable claim — *an approval outranks a more recently active session* — rather than a headcount.

### In the harness, which is the more useful list

Four separate ways this suite reported a PASS that was not true. Every one of them would have shipped a false green.

| | |
| :-- | :-- |
| **Graded an empty shell.** The Vite dev server was down, so the webview had no app in it. The Rust shell still answered `/health`, still returned `204`s, and measured beautifully — of nothing. 7/8. |
| **Posted to a source no adapter claims.** Every event dropped as `unknown-source`; it scored a pet that had received nothing. 7/8 again. |
| **The multi-session check could not fail.** Earlier checks create sessions of their own (`i1`, `lat`) and nothing evicts them for ten minutes, so `sessions >= 2` was already true before a single test event was posted. It would have passed with per-session tracking completely broken. |
| **Charged other applications' WebKit processes to the pet.** Helpers are matched by name because launchd spawns them, which collects every WebKit app on the machine. A busy browser turned a 0.1 % measurement into **12.5 %**. |

Two more that produced wrong numbers rather than wrong verdicts:

- **The latency median had no floor on successful samples.** A partially wedged pet answering 5 of 200 quickly would have scored better than a healthy one. Now requires 99 % delivered.
- **Idle cost was measured last, after 241 events.** That is recovery, not idle: it read 2 % against an isolated truth of 0.1 %, then 0.044 % on the next run purely because the collector happened to be quiet. A measurement that swings twentyfold on scheduling luck is not a measurement. It now runs first, before anything is sent.

That is Spike C's lesson three more times. It is worth stating as a rule, because this repo keeps rediscovering it:

> **A harness must prove it is pointed at something real before it measures, and the proof has to be a check that can fail.**

---

## Still owed

| | |
| :-- | :-- |
| The **8-hour soak**. Six minutes exercises eviction; it does not surface a slow leak, and the run above had not reached steady state. |
| A **real agent session** driving the pet end to end. Everything here is hand-posted payloads with recorded shapes. |
| **`exhausted` against a genuine rate limit** — TZX-63 still has no `StopFailure` fixture, and that event is the state's sole input. |
| **Release build** numbers. All of the above is debug. |
| **Windows** and **Linux/Wayland** — no host for either (TZX-74). |
| One **visual confirmation** of the Spike A overlay fix. `screencapture` is still refused for lack of Screen Recording permission, so the fix M1 and M2 both sit on has been measured and never seen. |
