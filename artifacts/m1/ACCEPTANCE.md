# M1 — acceptance pass

**Date:** 2026-08-01 · **Commit:** `main` after PR #12 · **Host:** macOS 25.5.0, Apple silicon

Walked against spec §14's M1 checklist, on the running app rather than on the test suite.

---

## Result: **M1 passes.** One checklist item is deferred with a reason.

| §14 M1 criterion | Result |
| :-- | :-- |
| `pnpm tauri dev` shows a transparent, draggable placeholder pet | ✅ |
| `POST /pet-event` visibly changes the animation | ✅ `204` → `working.digging` |
| `GET /health` returns the documented shape | ✅ |
| All nine states reachable from **Demo ▸** | ✅ — asserted by test across the five scenarios |
| Event log window works | ✅ |
| Tray: Show/Hide, Click-through, Demo, Event log, Copy hook config, Quit | ✅ after review — see below (plus Size, State glyphs) |
| Default pet loads **through the pack loader** | ✅ |
| A third-party pet renders through `stateMap` | ⏸ deferred — see below |
| State glyph layer renders over any pack | ✅ |
| Single-instance guard; busy port fails with an actionable message | ✅ second launch exits, first keeps running |

## Measured, not asserted

### I1 — the pet never changes agent behaviour

Four payload shapes, including two the app cannot parse:

```
{"hook_event_name":"Stop",...}   204  bytes=0
not json                         204  bytes=0
(empty)                          204  bytes=0
[1,2]                            204  bytes=0
```

Empty body every time. Structural rather than disciplined: nothing on the response path reads the body, so there is no code that *could* return a decision to the agent.

### I2 — the pet never slows the agent

40 requests each way:

| | median |
| :-- | --: |
| pet running | 7.63 ms |
| pet killed | 7.42 ms |

**Δ 0.21 ms**, against a criterion of < 5 ms. Both figures are dominated by `curl` process startup — the delta is the number that matters, and the killed case is connection-refused returning instantly on loopback.

### I6 — idle cost is zero

Re-measured with the real renderer, not Spike C's placeholder:

| | CPU (% of one core) | RSS |
| :-- | --: | :-- |
| animating (held in `working`) | 1.399 % | 355.8 → 358.9 MB |
| at rest (`sleeping`) | **0.116 %** | 358.9 → 358.8 MB |

Passes with headroom. Animating cost rose from Spike C's 0.200 % — the honest price of stepping a 1536 × 1872 atlas rather than translating a rectangle.

RSS is now ~359 MB. Spike C's C3 conclusion stands and is firmer: **memory is the cost worth watching, not CPU.**

### Multi-session — no thrash, attention wins

Session A asks for approval; session B then runs ten events in another project.

```
[pet] waiting_approval
[pet] waiting_approval (acme-api)
[pet] waiting_approval (acme-api)
```

The pet stays on A, and names A's project because two sessions are live. This is the failure §8 exists to prevent, and the one that would have made M2 pass on a demo and fail on a workday.

---

## Deferred: a third-party pet through the loader

The loader scans `~/.petdex/pets/` and `~/.codex/pets/`, but nothing has been installed there on this machine, so the path is covered by unit tests and not by a real pack.

Not blocking M1 — the format handling is derived from five real sheets in Spike D and the fallbacks are tested — but it should be exercised before M3 makes any claim about compatibility. Tracked on **TZX-69** as a follow-up rather than reopened.

## Corrections after code review

I ticked **Copy hook config** off above before it worked. The handler printed to stdout and emitted an event nobody listened for; no clipboard code existed anywhere in the repo. A menu item named *Copy* that copies nothing is worse than an absent one, and stdout is invisible in a bundled build. Now implemented, and the composition moved to the adapter — see below.

Five further defects came out of the review and are fixed in the same PR:

| | |
| :-- | :-- |
| **Persisted `scale` and `glyphs_enabled` never reached the frontend.** `pet-settings` only fires when the tray changes something, so every restart silently rendered at the frontend's own defaults while the tray menu correctly showed the saved values. | The frontend now asks once via `get_settings`, then listens. |
| **Click-through silently reset on hide → show.** `apply_overlay_behaviour` set the flag unconditionally and the show paths never re-applied the user's choice. | One `window::show` helper does all three things a show needs. |
| **Single instance forced the window visible** while leaving `hidden: true` on disk — pet on screen, tray claiming otherwise. | Relaunch now clears `hidden`, because relaunching *is* the request to see it. |
| **I5 was violated in the Rust shell**, which generated hook configuration containing an agent id and all eleven hook event names — and the I5 lint never scanned `src-tauri`, so the gap in the enforcement was worse than the violation. | Composition moved to the adapter; the shell only writes the clipboard. The lint now scans Rust too. |
| **The 250 ms drain loop was a 4 Hz timer** against an invariant that asks for nothing above 1 Hz at rest. Cheap when measured, but the literal text was not satisfied. | Event-driven now: the queue notifies, so an idle pet runs no timer at all — and latency drops to zero. |

Plus four comments that had drifted from their code: two citing Spike C's placeholder measurements rather than the real-renderer ones, one claiming the state machine holds no clock when six decays use real timers, and the architecture diagram still saying 8 KB.

## Found during the pass

**`PET_STATIC` had become dead code that still looked alive.** It added a CSS class whose rule went away with the placeholder frontend, so the flag silently did nothing while reading as a working feature. Removed; `sleeping` is reached through the state machine now, which is also a truer thing to measure.

## Not covered by M1, deliberately

Everything below belongs to M2 and is listed so the gap is explicit rather than assumed:

- A real agent session driving the pet end to end (M1 used hand-posted payloads with recorded shapes).
- The 8-hour soak and memory-flat-over-a-workday criterion.
- `exhausted` against a genuine rate limit.
- Plugin distribution.
