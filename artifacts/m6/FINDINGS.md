# Phase 2 — the claim, tested

> §5.2: *"Phase 2 adds one line here. Nothing else in `pet-core` changes."*

Written at M0 with one adapter in existence. A second one now exists, so the
claim can finally be wrong. Predictions were written first, in
[`PREDICTIONS.md`](PREDICTIONS.md), so this could disagree with them.

## Verdict

**True of the core. False of distribution. And it hid a coupling that only a
second adapter could expose.**

| # | Predicted | Outcome |
| :-- | :-- | :-- |
| 1 | `hookConfig` will not fit | **confirmed** |
| 2 | `copyHookConfig` will produce nonsense | **confirmed** |
| 3 | one tray item for a per-agent thing | **confirmed**, not fixed |
| 4 | `sessionId` has no answer for git | **wrong** — the repository is a better session than a chat is |
| 5 | the vocabulary needs new event types | **wrong** — not one was added |
| — | *(unpredicted)* | **every git commit celebrated, forever** |

## What the one line actually cost

Four lines, all mechanical: an import and an array entry in `registry.ts`, a
dependency in `pet-core/package.json`, an alias in `vitest.config.ts`. No state,
no event type, no change to the machine, the registry, the focus policy or the
renderer. For the core, the claim holds.

Both adapters then drove the same pet at once, from a real `git commit` and a
real agent session, with the bubble listing one line each.

## The finding nobody predicted

`celebrationWorthy` requires the turn to have lasted fifteen seconds:

```ts
at - ctx.turnStartedAt >= CELEBRATION_MIN_MS
```

`turnStartedAt` starts at `0` and is only ever set by `PROMPT_SUBMITTED`. Git
has no notion of a prompt and no reason to send one — so `at - 0` was the whole
Unix epoch, the duration test passed unconditionally, and **every commit earned
a trophy**. The first real `git commit` celebrated, and so would every commit
after it.

That is precisely the failure D5 exists to prevent: *"hoist a trophy every
twenty seconds and train the user to ignore it."* The guard written to enforce
D5 was silently relying on a habit of the only agent that existed when it was
written.

Fixed by requiring a turn the machine actually watched begin. The test that
covered this guard used `turnStartedAt: 0` as its baseline — encoding the
ambiguity rather than catching it.

**This is the argument for building a second adapter**, more than the adapter
itself. A single-agent codebase cannot tell a general rule from a local habit,
and no amount of review finds the difference, because the code is correct for
every input anyone has.

## Where the abstraction genuinely leaks

`PetAdapter.hookConfig(endpoint): string` assumes configuration is *text you
paste into a settings file*. Git's is *a script you run inside a repository*,
producing one executable file per hook. The signature accommodates it only by
lying about what the string is for.

`copyHookConfig` then joined every adapter's block with a blank line, which with
two adapters is a JSON object glued to a shell script — pasteable nowhere. It
now emits a document with a heading per agent, and is byte-identical to before
when only one adapter offers a config.

The honest fix is a tray submenu, one entry per adapter. That needs the shell to
learn which adapters exist, which it already receives via `report_ready` and
does nothing with. Left undone deliberately: it is a real change to the shell,
which is exactly the kind of thing "nothing else in `pet-core` changes" was
promising would not be needed.
