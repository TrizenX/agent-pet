# TZX-79 — the pet, driven by an actual agent

Everything the pet had ever seen was composed by us and posted with `curl`,
against fixtures recorded once in Spike B. This is the first time an agent drove
it.

## How, without touching anything of the user's

`claude --settings <file>` takes a settings path. So a real Claude Code session
can be pointed at the pet without installing a hook anywhere — `~/.claude/settings.json`
was never opened, and nothing needs uninstalling afterwards.

```sh
claude -p "<a small real task>" --settings /tmp/…/pet-settings.json
```

Two runs: one against the pet itself, one against `pet-adapter record` on a
separate port to capture payloads as fixtures.

## It works

Eight events, **0 dropped, 0 rejected**, and the pet walked the sequence:

```
sleeping → attentive  "Ừm…"
  working.reading     "Ngó tí…"      ← Read
  working.reading     "Làm đây!"     ← tool done, activity cleared
  working.typing      "Nắn nót…"     ← Edit
  working.typing      "Làm đây!"
  working.digging     "Hì hục…"      ← Bash
  celebrating         "Ngon!"
```

Two design decisions survive contact with reality:

**The activity clears between tools**, and it reads correctly — the pet drops to
a general word in the gap rather than naming a command that already finished.
That behaviour was argued for in M5 on principle; this is the first evidence it
looks right rather than merely being defensible.

**`celebrationWorthy` fired exactly once**, at the end. D5 worried that mapping
`Stop` to a trophy would "hoist a trophy every twenty seconds and train the user
to ignore it". The guard does its job.

## `SubagentStart` is real, and carries what the M5 review said it would

Recorded from a live session:

```json
{ "hook_event_name": "SubagentStart", "agent_id": "agent-0000",
  "agent_type": "Explore", "session_id": "…", "cwd": "…" }
```

This is the hook a comment in `mapping.ts` claimed did not exist, for which the
pet was inferring delegation from a tool name. `agent_type` is now in
`REQUIRED_FIELDS`, so its disappearance would fail a test rather than quietly
degrade the pet.

The fixture test caught its own gap the moment real data arrived: `EXPECTED` had
never learned the six hooks M5 added, so both new fixtures failed on
*"SubagentStart is not in the expected-event table"* until the table was filled
in. That is the drift check working.

## What did **not** fire — the more useful half

Ten registered hooks never arrived in a headless run:

| hook | reading |
| :-- | :-- |
| `SessionStart` | **Never fired.** The pet's first state came from `UserPromptSubmit`, so it went `sleeping → attentive` and never passed through `idle`. Either it fires before `--settings` is loaded, or `-p` does not emit it. |
| `PermissionRequest`, `PermissionDenied` | **Never fired, despite two refusals.** The session explicitly reported the Edit and the Bash "refused for lack of permission" — and no hook arrived. Headless has nobody to ask, so it appears to refuse without prompting. |
| `Notification` | Same reason: no prompts. |
| `PreCompact`, `PostCompact` | Sessions were far too short to compact. |
| `Elicitation`, `ElicitationResult` | No MCP server was in play. |
| `PostToolUseFailure`, `StopFailure` | Nothing failed, and nothing was rate limited. |

**So `waiting_approval` and `exhausted` are still unproven against a real agent.**
They are the two highest-value states in the product — §7.1 calls `exhausted`
"the highest-value state" outright — and a headless run structurally cannot
produce either. `StopFailure` from a genuine rate limit remains the last open
item of TZX-63, exactly as it was.

That is a real limit of this exercise, and it is worth stating plainly rather
than letting "the pet was driven by a real session" imply more than it did.

## What is now owed

An **interactive** session, where a permission prompt can actually appear. That
needs a human at a keyboard, not a subprocess.
