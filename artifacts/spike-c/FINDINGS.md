# M0 · Spike C — what the overlay costs while it sits there

**Date:** 2026-08-01 · **Host:** macOS 25.5.0, Apple silicon, on battery · **Build:** debug, 208 × 232 window

> Invariant I6 says idle cost is zero: while `sleeping` the app performs no animation and no repaints. A transparent, always-on-top window that composites continuously is the classic way to drain a laptop battery, and battery drain is the most common reason overlay apps get uninstalled.

Reproduce:

```sh
python3 tools/spike-overlay/measure_cpu.py \
  --binary packages/pet-core/src-tauri/target/debug/agent-pet \
  --minutes 2 --out artifacts/spike-c/cpu.json
```

---

## Verdict: **I6 PASSES**, and CPU is not the cost worth worrying about

| Mode | CPU (% of one core) | RSS |
| :-- | --: | :-- |
| animating | **0.200 %** | 274.6 → 267.7 MB |
| static (`sleeping`) | **0.042 %** | 275.0 → 274.8 MB |

Both are negligible. `sleeping` sits at roughly a fifth of the animating cost, which is consistent with process idle overhead rather than repaints — exactly what I6 asks for.

The animating figure is the more useful surprise: a CSS `steps()` animation on a 208 × 232 window costs **0.2 % of one core**. The worry that drove I6 — continuous compositing of a transparent always-on-top window — does not materialise at this size. I6 stays as written, because it is cheap to honour and the cost would scale with window size and frame count, but it is not load-bearing the way I1 and I2 are.

## C1 — the first measurement was wrong, and said so confidently

The initial probe used `ps -o cputimes=`. That is a **Linux** keyword; macOS `ps` rejects it outright:

```
ps: cputimes: keyword not found
```

`ps` wrote that to stderr, the parser saw no numeric output, and returned `0.0`. The result:

```
animating          cpu=  0.000%  (0.00s over 300s)
static (sleeping)  cpu=  0.000%  (0.00s over 300s)
-> PASS
```

A confident PASS from a probe that could not measure anything. An animating webview consuming exactly zero CPU is not a plausible reading, and the harness should have said so rather than reporting success.

Two changes came out of it, and the second matters more than the first:

1. Parse `cputime` (`[[HH:]MM:]SS.ss`) rather than the Linux `cputimes`.
2. **The harness now refuses to report a verdict when the animating case measures zero.** A measurement tool that cannot detect the thing it is measuring must fail loudly, not pass quietly.

## C2 — method

CPU is measured as *cumulative CPU time at t0 and t1, divided by wall time*. That is a true average over the interval. macOS `%CPU` is an average since process start, which for a long-lived process is meaningless for this question, and instantaneous sampling would need far more samples to say anything.

The whole process tree is measured, not just our binary. A Tauri app on macOS is four processes:

```
agent-pet
com.apple.WebKit.WebContent      <- where compositing actually lands
com.apple.WebKit.Networking
com.apple.WebKit.GPU
```

Measuring only the Rust binary would have reported near-zero for both modes and told us nothing.

## C3 — ⚠️ the real cost is memory, not CPU

**~275 MB RSS across the tree.** For a desktop pet that is the number a user will notice in Activity Monitor, and it is two orders of magnitude more interesting than the CPU figure.

Caveats before anyone panics: RSS counts shared WebKit framework pages that are already resident for any WebKit app, so the *marginal* cost is lower than 275 MB — and this is a debug build. But it is the honest headline, and it is a Tauri/WebKit floor rather than anything our code is doing.

Nothing to act on today. It becomes relevant at M2's soak test, where the criterion is *memory flat over a workday* — flat is achievable, small is not.

## C4 — not measured

- **Release build.** All figures are from a debug build.
- **GPU.** Only CPU time was sampled. Compositing cost may show up on the GPU rather than the CPU, and `powermetrics` needs root.
- **Real sprite animation.** The placeholder is one CSS transform. A 192 × 208 sprite sheet stepping through 8 frames is a different workload, though not obviously a heavier one.
- **Long horizon.** 2 minutes per mode. Enough for a CPU-time average; not enough to catch a slow leak. That belongs to the M2 soak.

---

## Actions

| # | Action | Where |
| :-- | :-- | :-- |
| C1 | Harness fails loudly when the probe reads zero | `measure_cpu.py` ✅ done |
| C2 | Keep `PET_STATIC` so `sleeping` stays measurable against the shipping binary | `main.rs` ✅ done |
| C3 | Track RSS in the M2 soak — the criterion is *flat*, not *small* | TZX-72 |
| C4 | Re-measure on a release build with real sprite art before any performance claim | TZX-69 |
