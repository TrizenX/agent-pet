# Releasing

What actually stops a release, separated from what is merely undone. The two get
conflated on a checklist, and the difference matters: one list is work, the other is
waiting on something outside the repository.

## Blocked on something we do not have

| | |
| :-- | :-- |
| **Signing and notarisation** | Needs an Apple Developer identity. Without it macOS Gatekeeper refuses the app on any machine but this one, so there is no distributable build at all. No amount of code fixes this. |
| **Mac App Store** | Ruled out, not pending. A transparent window requires `macOSPrivateApi`, which calls private API and makes the app ineligible — see [Spike A · A4](../artifacts/spike-a/FINDINGS.md). Direct download is the only path. |
| **Windows build** | No Windows host. `window.rs` has an empty non-macOS branch and the `alwaysOnTop` claim in §3.1 is unverified. |
| **Linux** | No host, and Wayland may make it impossible regardless (TZX-74). |

## Owed, and doable here

| | |
| :-- | :-- |
| **The 8-hour soak.** Six minutes exercises eviction; it does not surface a slow leak, and the last run had not reached steady state. |
| **An *interactive* agent session.** A headless one now drives the pet end to end (see [`artifacts/real-session/FINDINGS.md`](../artifacts/real-session/FINDINGS.md)) — but `-p` never emits a permission prompt, so `waiting_approval` and `exhausted`, the two highest-value states, remain unproven against a real agent. That needs a human at a keyboard. |
| **`StopFailure` recorded from a real rate limit** (TZX-63). It is the sole input to `exhausted`, and that state has never been driven by a genuine event. |
| **Release-build numbers.** Every measurement in `artifacts/` is a debug build. |
| ~~One visual confirmation of the overlay over a full-screen app.~~ Done — `tools/layout/fullscreen.py` drives a real full-screen Space and measures what the pet drew there. |

## Not blocking

The bundled pet is placeholder art. It is ours and it ships fine (see [`IP_POLICY.md`](IP_POLICY.md)); replacing it with something better-looking is polish, not a gate (TZX-73).

## Before tagging

```sh
rm -rf packages/pet-core/{dist,node_modules/.vite}   # see vite.config.ts
pnpm verify                                    # typecheck, lint, I5, hooks drift, tests
pnpm verify:rust                               # rustfmt --check, then cargo test
pnpm --filter @agent-pet/pet-core tauri build --no-bundle
python3 tools/layout/check.py      --binary packages/pet-core/src-tauri/target/release/agent-pet
python3 tools/layout/fullscreen.py --binary packages/pet-core/src-tauri/target/release/agent-pet
node packages/adapter-claude-code/src/cli.ts record --install   # re-record fixtures
python3 tools/invariants/verify.py --binary … --soak-minutes 480
```

Re-recording the fixtures is not optional. The hook schema has already moved once under us — `PostToolUse` lost the `is_error` the documentation still lists — and the fixtures are the only thing that notices.
