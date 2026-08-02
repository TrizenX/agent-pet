# M0 · Spike A — macOS overlay above full-screen apps

**Date:** 2026-08-01 · **Host:** macOS 25.5.0, Apple silicon, 1512×982 pt primary display · **Build:** Tauri 2, `packages/pet-core/src-tauri`

> **The gate.** A plain always-on-top window does not float above a full-screen macOS app. Many developers run their terminal full-screen, so if this cannot be solved the pet disappears exactly when it matters and §1.1's thesis fails.

---

## Verdict: **PASSED** — and, as of 2026-08-02, photographed

This spike proved the fix by asking the window server whether our window was
onscreen and at layer 25. That is good evidence and it stops one step short: the
window server will call a window onscreen while it draws nothing anyone could
see. `tools/layout/fullscreen.py` closes the gap — it drives a real full-screen
Space, captures the screen with the pet running and again a second after killing
it, and diffs the pet's rectangle between the two frames. **8.6 % of that
rectangle was the pet; the untouched page beside it differed by 0.0 %.**


The fix is **re-classing the Tauri `NSWindow` as a non-activating `NSPanel`**. Collection behaviour and window level are necessary but were never sufficient; the class is what decides whether the window server treats the window as auxiliary chrome that follows the user, or as a document window that belongs to one Space.

| Configuration | Normal desktop | Over a full-screen app |
| :-- | :-: | :-: |
| baseline (`orderFrontRegardless`, level 25, 4-bit behaviour) | 13/13 | 12/57 |
| \+ re-assert on `NSWorkspaceActiveSpaceDidChangeNotification` | 10/10 | 15/60 |
| \+ `orderOut:` before the re-entry | 5/5 | 10/55 |
| **\+ non-activating `NSPanel`** | **1/1** | **69/69** ✅ |

Shipping configuration:

```
object_setClass(nsWindow, NSPanel)
styleMask         |= NSWindowStyleMaskNonactivatingPanel
floatingPanel      = YES
becomesKeyOnlyIfNeeded = YES
hidesOnDeactivate  = NO
collectionBehavior = canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary  (0x151)
level              = 25   (NSStatusWindowLevel)
+ orderFrontRegardless
+ NSApplicationActivationPolicyAccessory
```

**Control.** The three rows above the fix are the control group: three different configurations, three separate live sessions, 37/172 ≈ 21 % combined. The fix scores 69/69 in the same harness. A same-binary A/B is one command away if anyone wants it — `PET_USE_NSPANEL=0` restores the old behaviour.

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

## A3 — the transition case, which A2 alone would have called a false pass ⚠️ *(resolved by A6)*

A2 creates each window inside an already-active full-screen space. **That is not what users do.** Users have the pet running and then press ⌃⌘F.

`watch_transition.py` samples once a second across live enter/exit, correlating our window's onscreen state with whether a full-screen space exists. All three configurations behave the same way: perfect on the desktop, ~20 % over full screen.

The reading that fits the data: **a window's Space membership is bound when it is ordered in**, and entering full screen creates a *new* Space that the existing window does not join — `canJoinAllSpaces` notwithstanding. Creating the window inside that Space works (A2); migrating an existing one into it does not. Re-asserting the behaviour on `NSWorkspaceActiveSpaceDidChangeNotification`, with or without an `orderOut:` first, does not rebind it.

The intermittent ~20 % is consistent with the window surfacing during transition animations rather than genuinely living in the full-screen Space.

**A6 fixes this.** The reading above turned out to be right about the symptom and wrong about the cause: the problem is not *when* the window is ordered in, it is *what class it is*.

### Caveat on the measurement

`kCGWindowListOptionOnScreenOnly` reports windows on the *currently active* Space, which is the right question — and Control Center's own layer-25 items report reliably through the same call.

`screencapture` fails with *"could not create image from display"* because the terminal lacks Screen Recording permission, so **no human has visually confirmed any of this**. The 21 % → 100 % swing under a single code change, in the same harness, is strong evidence that the harness measures something real. It is still worth one glance at the screen before M1 leans on this.

## A6 — the fix: a non-activating `NSPanel` ✅

Collection behaviour and window level are properties. The **class** is the thing that decides how the window server files the window.

Tauri creates an `NSWindow`. Re-classing it to `NSPanel` via `object_setClass` and adding `NSWindowStyleMaskNonactivatingPanel` makes the window server treat it as auxiliary chrome that follows the user rather than a document window belonging to one Space. `NSPanel` adds no instance variables over `NSWindow`, so the isa-swizzle is safe; the style-mask bit is meaningless on a plain `NSWindow`, which is why the class has to change first and the order in `window.rs` matters.

```
69/69 samples visible across live full-screen enter/exit
```

Three supporting properties come with it, and each earns its place:

| Property | Why |
| :-- | :-- |
| `floatingPanel = YES` | float above the owning app's own windows |
| `becomesKeyOnlyIfNeeded = YES` | clicking the pet must not steal focus from the editor |
| `hidesOnDeactivate = NO` | the app is *always* deactivated — it is a background overlay |

The `NSWorkspaceActiveSpaceDidChangeNotification` observer from A3 is kept. It measured as useless on its own, but it is the correct place to re-assert state and costs nothing when the user is not switching Spaces — unlike a polling timer, which would threaten I6.

`PET_USE_NSPANEL=0` restores the pre-fix behaviour for A/B testing.

## A4 — ⚠️ `macOSPrivateApi` blocks the Mac App Store

A transparent Tauri window on macOS requires `"macOSPrivateApi": true`. As the name says, that calls private API, **and it makes the app ineligible for the Mac App Store.**

Spec §16 currently reads *"Mac App Store is viable — because of D4"*, reasoning that plugin distribution removes the sandbox problem. D4 solved the filesystem half. This is the other half, and it is not solved: transparency is not optional for a pet-shaped overlay, so today the choice is a transparent pet **or** the App Store, not both. Direct download plus a merchant of record is unaffected.

§16 needs amending. This is independent of A3 and A6 — it is about transparency, not about Spaces.

## A5 — Windows: not measured

This host is macOS. Spec §3.1 claims `alwaysOnTop` (`HWND_TOPMOST`) suffices on Windows; that is still unverified and `window.rs` has an empty non-macOS branch. Needs a Windows host before M1 closes.

---

## Still open

1. **One visual confirmation.** Grant Screen Recording to the terminal and look at the pet over a full-screen app. The metadata says it works; nobody has looked.
2. **Windows** (A5) — unverified, no host available here.
3. **Multi-monitor and "Displays have separate Spaces"** — untested. Likely fine given the panel class, but it is an assumption.

## Actions

| # | Action | Where |
| :-- | :-- | :-- |
| A1 | Keep `orderFrontRegardless`; never rely on `show()` alone with `focus: false` | `window.rs` ✅ done |
| A2 | Keep level 25 and the full four-bit behaviour; do not "simplify" to two bits | `window.rs` ✅ done |
| A3 | Superseded by A6 | — |
| A6 | **Ship the non-activating `NSPanel` conversion.** This is the fix | `window.rs` ✅ done |
| A4 | Amend spec §16 — the App Store is blocked by `macOSPrivateApi`, not only by sandboxing | `PET_PROJECT_SPEC.md` |
| A5 | Verify the Windows path on a Windows host | TZX-65 |
