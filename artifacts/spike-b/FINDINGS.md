# M0 · Spike B — hook payloads recorded from a live agent

**Date:** 2026-08-01 · **Captured:** 13 payloads across 5 hook events · **Fixtures:** `packages/adapter-claude-code/test/fixtures/`

> The mapping in `mapping.ts` was written against documentation. Documentation drifts; payloads recorded from a live agent do not. This is the only real defence against a hook schema that keeps moving (spec §11.1).

Reproduce:

```sh
node packages/adapter-claude-code/src/cli.ts record --install --port 48201 \
  --out packages/adapter-claude-code/test/fixtures
# run an agent session, then ctrl-c — hooks are removed on exit
```

---

## Verdict: **PASSED**, with two corrections to the documented schema

The mapping is correct. Two of its assumptions came from documentation that reality does not match, and one of them would have silently broken the `error` state if we had followed the docs literally.

## B1 — hooks reload mid-session

The recorder installed hooks into `~/.claude/settings.json` and captured a payload from **the very session that installed them**, with no restart. Useful for the product: `pet-adapter install` takes effect immediately, so the pet starts reacting without asking the user to restart anything.

## B2 — ⚠️ `PostToolUse` does not carry `is_error`

The reference lists `is_error` on `PostToolUse`. It was absent from every recorded payload. What is actually there:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_response": { "stdout": "…", "stderr": "…", "interrupted": false },
  "duration_ms": 60
}
```

**This vindicates D-registering `PostToolUseFailure` as a separate event.** Had we followed §6.3's documented route and inferred failure from `PostToolUse.is_error`, the `error` state would never have fired — and it would have looked like a state-machine bug, not a schema mismatch.

The defensive `is_error` read stays in `mapping.ts`, pinned by a drift test so we notice if it ever appears.

## B3 — `PostToolUseFailure` reports `error`, not `is_error`

```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "error": "<string>",
  "is_interrupt": false,
  "duration_ms": 60
}
```

`is_interrupt` distinguishes a user interrupt from a genuine tool failure — worth using in M1 so cancelling a command does not make the pet fall over.

## B4 — `Notification` and `PermissionRequest` match the mapping exactly

`notification_type: "permission_prompt"` arrived verbatim, and `PermissionRequest` carries `tool_name`, so the speech bubble can name the tool being approved. Both were assumptions; both hold.

## B5 — undocumented fields, and why forward compatibility earns its place

Observed but not in the reference we worked from: `prompt_id`, `effort`, `duration_ms`, `tool_response`, `permission_suggestions`, `is_interrupt`.

None break anything, because the mapping reads a whitelist and ignores the rest. That was a design choice made on principle (§6.2) and it is now a measured one.

## B6 — coverage: 5 of 11 events

| Captured | Not captured | Why |
| :-- | :-- | :-- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification` | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop` | Session and turn boundaries — need the recorder running across a session start/stop, not within one |
| | `PermissionDenied` | Fires when the auto-mode classifier denies a call; not reproducible on demand |
| | `StopFailure` | Needs a real rate limit, billing failure or auth error |

The four lifecycle events are a one-command follow-up: leave the recorder installed, start a fresh agent session, quit it. `StopFailure` is worth capturing opportunistically the next time a rate limit happens, because it is the input to `exhausted` — the state with the best signal-to-effort ratio in the product.

## B7 — redaction, because these are committed to a public repo

Raw payloads carry absolute paths, prompt text, tool inputs and transcript locations. The recorder redacts at capture time: **keys are preserved, free-text values are replaced** with `<redacted:string:N>`, and identifiers get stable placeholders. The fixture still proves the schema; none of it leaks. A test asserts no unredacted home directory survives, so a `--no-redact` recording cannot be committed by accident.

## B8 — the settings.json merge, verified against the real file

Installed into and removed from the actual `~/.claude/settings.json`:

- 11 hook events merged in, unrelated settings untouched
- automatic backup written before the first write
- on removal: **byte-identical** to the backup, verified with `filecmp`

17 unit tests cover the rest: idempotency across three runs, preserving a user's own hooks on events we also use, identifying our entries by URL rather than position (so a user editing the file between install and uninstall is safe), and leaving another port's entries alone.

---

## Actions

| # | Action | Where |
| :-- | :-- | :-- |
| B2 | Keep `PostToolUseFailure` registered; never rely on `PostToolUse.is_error` | `mapping.ts` ✅ |
| B3 | Use `is_interrupt` so a cancelled command is not shown as an error | M1, TZX-67 |
| B6 | Capture the four lifecycle events across a session boundary | TZX-63 stays open |
| B6 | Capture `StopFailure` opportunistically on the next rate limit | TZX-63 |
| B7 | Re-record before every release; redaction stays on | `docs/` |
