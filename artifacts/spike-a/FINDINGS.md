# M0 · Spike A — macOS overlay above full-screen apps

**Date:** 2026-08-01 · **Host:** macOS 25.5.0, Apple silicon, 1512×982 pt primary display · **Build:** Tauri 2, `packages/pet-core/src-tauri`

> **The gate.** A plain always-on-top window does not float above a full-screen macOS app. Many developers run their terminal full-screen, so if this cannot be solved the pet disappears exactly when it matters and §1.1's thesis fails.

---

## Verdict: **NOT PASSED**

The overlay is solid on the normal desktop and unreliable over a full-screen app. Three configurations were measured against a live full-screen transition; none exceeded ~27 % visibility.

| Configuration | Normal desktop | Full-screen space |
| :-- | :-: | :-: |
| baseline (`orderFrontRegardless`, level 25, 4-bit behaviour) | 13/13 | **12/57** |
| \+ re-assert on `NSWorkspaceActiveSpaceDidChangeNotification` | 10/10 | **15/60** |
| \+ `orderOut:` before the re-entry | 5/5 | **10/55** |

Per spec §14 this gate says *stop and revisit the product thesis before writing further code*. Do not start M1's renderer against an unproven overlay. See "What to try next" — this is a *blocked*, not a *dead*, spike; several documented approaches remain untried.

Reproduce:

```sh
cargo build --manifest-path packages/pet-core/src-tauri/Cargo.toml
./packages/pet-core/src-tauri/target/debug/agent-pet &

pip install pyobjc-framework-Quartz
python3 tools/spike-overlay/inspect_windows.py                    # snapshot
python3 tools/spike-overlay/sweep_levels.py   --binary … --out …  # level × behaviour matrix
python3 tools/spike-overlay/watch_transition.py --seconds 70      # enter/leave full screen
```

Evidence comes from `CGWindowListCopyWindowInfo` — the window server's own view — not from reading back the same Objective-C properties we set. Reading back what you just wrote proves nothing.

---

## A1 — `orderFrontRegardless` is required, and its absence looks like a different bug

With `focus: false` in `tauri.conf.json` the app never activates, and **an unactivated app's windows are never ordered onto the screen**. `WebviewWindow::show()` does not fix it.

The failure is deceptive: the window exists in the window server with the correct level, correct bounds and `alpha = 1.0`, and is simply not displayed.

```
kCGWindowListOptionAll          -> layer 25, name 'Agent Pet', bounds 1256,654 208×232
kCGWindowListOptionOnScreenOnly -> absent
```

`focus: false` is not negotiable — an overlay that steals focus from the editor on launch is worse than no overlay. `orderFrontRegardless` displays the window *without* activating the app, which is exactly the required semantics. **This is a real fix and it stays.**

## A2 — level × behaviour matrix: 10 of 12 work, but only for a freshly-created window

12 combinations, each a fresh process started **while a full-screen space was already active** (`level-sweep.json`):

| level | collectionBehavior | visible | reported layer |
| --: | :-- | :-: | --: |
| 25 | canJoinAllSpaces\|stationary\|ignoresCycle\|fullScreenAuxiliary | ✅ | 25 |
| 25 | …\|transient | ✅ | 25 |
| 25 | canJoinAllSpaces\|fullScreenAuxiliary | ✅ | **5** ← silently demoted |
| 101 | all three variants | ✅ | 101 |
| 200 | canJoinAllSpaces\|stationary\|ignoresCycle\|fullScreenAuxiliary | ✅ | 200 |
| 200 | …\|transient | ❌ | — |
| 200 | canJoinAllSpaces\|fullScreenAuxiliary | ❌ | — |
| 1000 | all three variants | ✅ | 1000 |

Two results worth keeping:

- **Level 25 is enough** when it works at all. No need to climb to `NSScreenSaverWindowLevel`; sitting with the menu bar rather than above it keeps the pet below system alerts, which is the polite choice for something on screen all day.
- **Dropping `stationary` and `ignoresCycle` silently demoted the window to layer 5** despite asking for 25. Those bits are not cosmetic, and the two-bit "minimal" form is not a safe simplification.

## A3 — the transition case, which A2 alone would have called a false pass ⚠️

A2 creates each window inside an already-active full-screen space. **That is not what users do.** Users have the pet running and then press ⌃⌘F.

`watch_transition.py` samples once a second across live enter/exit, correlating our window's onscreen state with whether a full-screen space exists. All three configurations behave the same way: perfect on the desktop, ~20 % over full screen.

The reading that fits the data: **a window's Space membership is bound when it is ordered in**, and entering full screen creates a *new* Space that the existing window does not join — `canJoinAllSpaces` notwithstanding. Creating the window inside that Space works (A2); migrating an existing one into it does not. Re-asserting the behaviour on `NSWorkspaceActiveSpaceDidChangeNotification`, with or without an `orderOut:` first, does not rebind it.

The intermittent ~20 % is consistent with the window surfacing during transition animations rather than genuinely living in the full-screen Space.

### Caveat on the measurement

`kCGWindowListOptionOnScreenOnly` reports windows on the *currently active* Space, which is the right question — and Control Center's own layer-25 items report reliably through the same call, so the method is not obviously blind to status-level windows.

But this has **not been confirmed by a human looking at the screen**: `screencapture` fails with *"could not create image from display"* because the terminal lacks Screen Recording permission, so no visual evidence could be captured. Before acting on this verdict, grant Screen Recording to the terminal (or just look at the screen) and check whether the pet is genuinely absent. A measurement artefact here would change the conclusion entirely.

## A4 — ⚠️ `macOSPrivateApi` blocks the Mac App Store

A transparent Tauri window on macOS requires `"macOSPrivateApi": true`. As the name says, that calls private API, **and it makes the app ineligible for the Mac App Store.**

Spec §16 currently reads *"Mac App Store is viable — because of D4"*, reasoning that plugin distribution removes the sandbox problem. D4 solved the filesystem half. This is the other half, and it is not solved: transparency is not optional for a pet-shaped overlay, so today the choice is a transparent pet **or** the App Store, not both. Direct download plus a merchant of record is unaffected.

§16 needs amending regardless of how A3 resolves.

## A5 — Windows: not measured

This host is macOS. Spec §3.1 claims `alwaysOnTop` (`HWND_TOPMOST`) suffices on Windows; that is still unverified and `window.rs` has an empty non-macOS branch. Needs a Windows host before M1 closes.

---

## What to try next, cheapest first

1. **Confirm the measurement by eye.** Grant Screen Recording and look. Everything below is wasted if A3 is an instrumentation artefact.
2. **`NSPanel` with `NSWindowStyleMaskNonactivatingPanel`.** The approach most overlay apps actually ship. Tauri creates an `NSWindow`; the style mask can be added post-hoc, or the class swapped. Untried, and the most likely fix.
3. **Recreate the window on Space change** instead of re-ordering it. Ugly, and it would reset webview state, but it directly matches the "membership is bound at order-in" reading, which A2 supports.
4. **Accept a degraded mode.** If none of the above works, the pet cannot be an overlay for full-screen users, and §1.1's thesis has to be re-scoped — for example to a menu-bar item that carries the same state, which is far less charming but keeps the instrument.

---

## Actions

| # | Action | Where |
| :-- | :-- | :-- |
| A1 | Keep `orderFrontRegardless`; never rely on `show()` alone with `focus: false` | `window.rs` ✅ done |
| A2 | Keep level 25 and the full four-bit behaviour; do not "simplify" to two bits | `window.rs` ✅ done |
| A3 | **Gate not passed.** Confirm by eye, then try the `NSPanel` route | TZX-62, stays open |
| A4 | Amend spec §16 — the App Store is blocked by `macOSPrivateApi`, not only by sandboxing | `PET_PROJECT_SPEC.md` |
| A5 | Verify the Windows path on a Windows host | TZX-65 |
