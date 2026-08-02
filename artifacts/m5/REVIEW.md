# M5 code review

Five reviewers over `07a14e5..main`. Nine defects survived verification, all
fixed. No recurrence of the twelve defects M1–M4 catalogued — every finding is
in code M5 wrote, which is now the pattern for three milestones running.

Two findings came from a reviewer that went and read the upstream documentation
instead of trusting the code's own comments, and one of those comments turned
out to be simply false.

---

## 1. My comment said a hook did not exist. It does.

`mapping.ts` claimed: *"There is no matching start hook — the pet learns a
subagent began from `PreToolUse` on a delegating tool."*

`SubagentStart` is real, documented, and carries `agent_type`. So M5 inferred
delegation from a tool name while the authoritative signal sat unregistered —
and `SUBAGENT_START`, in the wire format since M0 and marked "accepted and
ignored", stayed dead for no reason at all.

The same paragraph was echoed in `petMachine.ts`, so the wrong claim had been
copied before anyone checked it.

**Fixed**, and three more hooks came with it once someone actually enumerated
the list:

| hook | why it matters |
| :-- | :-- |
| `SubagentStart` | the authoritative delegation start, with `agent_type` |
| `PostCompact` | `compacting` had **no end signal** — it unwound on a five-minute decay, a guess wearing the clothes of a fact |
| `Elicitation` | an MCP server asking the user a question; was being dropped |
| `ElicitationResult` | and its answer |

Thirteen registered hooks became seventeen.

## 2. A third stale activity, on the worst possible path

M5 already found and fixed two transitions that forgot to clear the recorded
tool: the `TOOL_START` fallback branch, and `SUBAGENT_END`. A reviewer found the
third by enumerating every transition rather than by using the app:

```
TOOL_START{bash} → working.digging, activity="bash"
…no further events…
after ACTIVITY_DECAY → idle, activity="bash"     ← stale
```

`working`'s own decay. That is the one exit that exists **specifically** for a
hook that never arrived — which is exactly when a stale "Crunching…" is most
likely to be on screen and most likely to be a lie.

Three instances of one bug in one milestone is not three mistakes, it is a
missing rule. The rule is now written in spec §7.2: *anything leaving work
forgets what the work was.*

## 3. The pet moonwalked

`Pet.tsx` only swapped to a left-facing row when the current row was
`running-right`, which is `working.digging` and nothing else. But the pet paces
in **all four** working states. So in `typing`, `reading`, `delegating` and
`generic` the window slid left while the sprite stayed drawn facing right —
about half the time, visibly walking backwards.

**Fixed** by mirroring any working row when travelling left, xor'd against the
flip `resolveRow` may already have applied for a pack with no row 2.

## 4. Reduced motion stopped the sprite and not the window

`tray.rs` had it right for the tray toggle: *"Off means off immediately,
including mid-stride."* But `walk::halt` was never registered as a command, so
the frontend had no way to ask for it. Turning on `prefers-reduced-motion`
mid-stride froze the sprite while the window kept sliding for up to 2.4 s —
precisely the motion the setting exists to suppress.

**Fixed:** `halt_walking` is a command now. Work finishing still lets the pet
walk home; a user saying *stop moving* stops it.

## 5. Two ways to lose the pet off-screen

Both from `walk.rs`, both found by reading Tauri's own dispatch code:

**The exits skipped clamping.** Every intermediate step went through
`clamp_to_visible`; the two final placements — arriving home, and `halt` — did
not. `home` is captured once when work starts, and a display can be unplugged
during a multi-minute agent run. The pet would teleport to coordinates that no
longer exist, with no timer left running to rescue it, and the bad position was
then persisted to disk.

**A straggling move could outrun `halt`.** `set_position` applies inline when
called from the main thread and is *queued* when called from another. `halt`
runs on the main thread; the walker runs on a tokio worker. So a step issued up
to 80 ms earlier could land after `halt` had already placed the pet home — and
because the code remembered only the single most recent commanded position, that
straggler read as a hand on the window and got persisted.

**Fixed:** both exits clamp, and the walker remembers its last eight commands
instead of one, so a late step is still recognised as its own.

## 6. Tests that could not fail

A reviewer broke each new test's production code, ran it, and reverted. Most
held. One did not:

Removing `"waiting_input"` from `ATTENTION_STATES` — reverting the actual
feature, so a question would no longer outrank a busier session — left **all 15
tests in `focus.test.ts` passing**. The state was added to the set in M5 and
nothing in the focus suite noticed.

**Fixed** with three tests that fail without it, verified by removing it again.

## 7. `walk.rs` shipped with no tests

219 lines, including genuinely testable pure logic, in a crate where every other
Rust module has tests. Eight added, covering drag discrimination, the straggler
case above, and the property that keeps I6 honest — that the walk-home loop
always terminates, because that loop ending is what drops the timer.

## 8. Two smaller ones

`useWalk` keyed its effect on `state`, and the pet changes working substate on
every tool call — so it sent one IPC message per tool call while the answer
never changed, contradicting its own comment claiming "twice per burst". Now
compared against a ref.

`fixtures.test.ts` still asserted `agent_needs_input → AGENT_IDLE` after M5
changed it to `INPUT_NEEDED`. Latent only because no fixture exercises it — and
it would have been "fixed" by reverting the behaviour the next time someone
re-recorded.

## Spec drift

§7.1 still listed eight states after the machine grew to fourteen, and §7.2 had
no rows for the new transitions or decays. §14's M5 entry was honest; §7 — the
section §2 points at for I3 and I4 — was not. Both updated.

---

## Still owed

The two new hook events have **no recorded fixtures**. `record.ts` exists for
exactly this and has not been run since they were added, so the mappings are
verified against payloads I composed, not payloads Claude Code sent. Spike B
already found the documentation wrong once — `PostToolUse` does not carry the
`is_error` it documents. This is TZX-79's job and TZX-79 needs the user's
machine.
