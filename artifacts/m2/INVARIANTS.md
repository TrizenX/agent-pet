# M2 — invariant verification

**Date:** 2026-08-02 · **Host:** macOS 25.5.0, Apple silicon, debug build

```sh
pnpm --filter @agent-pet/pet-core dev:vite &
python3 tools/invariants/verify.py \
  --binary packages/pet-core/src-tauri/target/debug/agent-pet \
  --idle-seconds 45 --soak-minutes 10 --out artifacts/m2/invariants.json
```

The unit tests prove the code does what it was written to do. This proves the assembled application does, against a real endpoint and a real process tree — and the two invariants that matter most cannot be unit-tested at all, because both are claims about the *agent* rather than about us.

---

## 8/8

| | Check | Result |
| :-- | :-- | :-- |
| **I1** | every hook response is `204` with an empty body | 8 payload shapes — ordinary, unparseable, empty, truncated, wrong-shape, `null`, 50-deep nesting, 200 KB — all `204`/0 bytes |
| §10 | browser-originated requests refused | `origin`, `sec-fetch-site`, `sec-fetch-mode` → `403` |
| **I2** | hook round-trip | **median 0.202 ms**, p99 0.439 ms over 200 requests |
| **I2** | a stopped pet costs nothing | 0.106 ms per refused connection |
| **I2** | **a hung pet still bounds the wait** | 2502 ms, then the hook timeout fires |
| §8 | concurrent sessions tracked separately | 4 live sessions after interleaving two |
| **I6** | idle cost | 0.200 % of one core over 45 s |
| soak | memory stays flat | 378 → 255 MB over 10 min, 119 sessions |

### The one that matters: a hung pet

A *stopped* pet is the easy case — connection refused on loopback returns in a tenth of a millisecond. A **hung** one is what would actually make the agent wait, and the hook's `timeout: 2` is the only thing between the user and a pause on every tool call.

Measured by `SIGSTOP`-ing the process mid-flight: the client waited 2502 ms and then gave up, exactly as the hook would. This is the case §14's M2 checklist asks for and the one a simpler harness would have skipped.

### On the latency number

**0.202 ms**, measured over a reused HTTP connection. M1's acceptance pass reported 7.63 ms for the same thing — that figure was almost entirely `curl` process startup, and the delta it computed (0.21 ms) happened to be right for the wrong reason. Measuring properly makes the absolute number meaningful too.

### On the memory number

RSS fell over the soak rather than rising. That is a warm-up curve settling, not a leak: the sprite atlas decode and React boot peak early and are reclaimed. The criterion is *flat*, and a negative slope satisfies it.

**This is a 10-minute soak, not the 8-hour one §14 asks for.** 119 sessions were created and evicted, which exercises the registry's eviction path hard, but a slow leak on a longer horizon would not show. The 8-hour run is still owed.

---

## The suite found two bugs, and one of them was in itself

**`/health` reported `sessions: 0` permanently.** The frontend called `report_ready` once at mount, when the count was necessarily zero, and never again. Nothing in the unit tests could catch this — the registry was correct, the endpoint was correct, and only the wire between them was wrong. Fixed: re-reported whenever the count changes.

**The harness graded an empty shell and gave it 7/8.** Two separate mistakes, both mine, both the same shape:

- The Vite dev server was not running, so the webview had no app in it. The Rust shell still answered `/health`, still returned `204`s, and still measured beautifully — of nothing.
- The harness posted to `/event/some-agent`, a source no adapter claims, so every event was dropped as `unknown-source`. It scored a pet that had received nothing.

Both now abort before measuring: the suite waits for `webview.connected`, refuses to run if the webview reports no adapters, and takes the source from `/health` rather than hardcoding one.

This is Spike C's lesson for the third time — a probe that cannot detect that it is measuring nothing must fail loudly, not pass quietly. It is worth stating as a rule: **every harness in this repo needs a check that it is pointed at something real, and the check has to run before the measurements, not after.**

---

## Still owed

| | |
| :-- | :-- |
| The **8-hour soak**. 10 minutes exercises eviction; it does not surface a slow leak. |
| A **real agent session** driving the pet end to end. Everything here uses hand-posted payloads with recorded shapes. |
| **`exhausted` against a genuine rate limit** — TZX-63 still has no `StopFailure` fixture, and that event is the state's sole input. |
| **Release build** numbers. Everything above is debug. |
| **Windows** and **Linux/Wayland** — no host for either (TZX-74). |
| One **visual confirmation** of the Spike A overlay fix; `screencapture` is still refused for lack of Screen Recording permission. |
