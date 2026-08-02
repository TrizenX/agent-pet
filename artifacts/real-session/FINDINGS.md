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

## Round two: what a headless session *can* be made to produce

`PreCompact` and `PostCompact`, both now recorded.

`claude -p "/compact"` fires `PreCompact` even when the compaction is then
refused for having too little to compact — the hook is the request, not the
outcome. Five turns of `-c` build enough history for the real thing, and
`PostCompact` arrives carrying `compact_summary`.

Both payloads carry `trigger: "manual"`, which is the matcher those hooks accept.
Neither is used by the mapping; recorded so the shape is pinned.

## What a headless session cannot produce, and why

Five registered hooks still have no recorded payload. Each was attempted:

| hook | attempted | why it cannot fire |
| :-- | :-- | :-- |
| `PermissionDenied` | a `deny` rule on `Bash(rm:*)`, then asking for `rm` | the command was refused and **no hook fired at all**. `-p` blocks the tool without running the permission flow — there is nobody to ask, so there is nothing to deny |
| `SessionStart` | every run above, including `-c` resumes | never fires in `-p`. `SessionEnd` does, which makes the asymmetry a fact rather than a guess. The pet therefore enters a headless session at `attentive`, never passing through `idle` |
| `Elicitation`, `ElicitationResult` | — | needs an MCP server that asks the user something mid-tool |
| `StopFailure` | — | needs a genuine rate limit or API failure. Cannot be manufactured, and should not be |

`StopFailure` is the one that matters. It is the **sole** input to `exhausted`,
which §7.1 calls the highest-value state in the product, and that state has
still never been entered by a real event. The mapping is exercised by
hand-written payloads and by `BLOCK_REASONS`, and neither is evidence about the
shape upstream actually sends.

## `exhausted` is interactive-only, and now that is measured rather than assumed

`StopFailure` is the sole input to `exhausted`, which §7.1 calls the highest-value
state in the product. I had recorded it as "needs a genuine rate limit, cannot be
manufactured". That was giving up early on two counts.

**`rate_limit` is one of eight.** Every entry in `BLOCK_REASONS` — overloaded,
billing, auth, invalid_request, server_error — lands in the same `AGENT_BLOCKED`
event and the same state. Any real API failure would have done.

**And an API failure can be manufactured**, without burning a token or touching
an account: point the client at a server that fails. `ANTHROPIC_BASE_URL` at a
local endpoint returning `429` with a `rate_limit_error` body is a real rate
limit as far as the real client is concerned.

Two variants were run against a real headless session:

| endpoint returns | what happened | hooks fired |
| :-- | :-- | :-- |
| `429 rate_limit_error` | the client retried with backoff for over ten minutes | `UserPromptSubmit`, `SessionEnd` |
| `401 authentication_error` | failed immediately | `UserPromptSubmit`, `SessionEnd` |

**No `StopFailure` in either case.** The turn failed and the session simply ended.

That completes a pattern rather than adding an isolated fact. Four hooks have
never appeared in any headless run — `SessionStart`, `PermissionRequest`,
`PermissionDenied`, `StopFailure` — while `PermissionRequest` and `Notification`
*were* captured from the user's live interactive sessions. They are not missing
because the right conditions never arose; `-p` does not emit the interaction and
lifecycle hooks at all.

So `exhausted` needs an interactive session that hits an API failure. That is a
narrower and more actionable statement than "needs a rate limit": it does not
need quota to run out, only a human at a keyboard when something upstream breaks.

## Capturing the rest

The remaining four need an interactive session, which means a human at a
keyboard. They can be harvested passively by pointing a recorder at a second
port alongside the running pet:

```sh
node packages/adapter-claude-code/src/cli.ts record --port 48201 --out packages/adapter-claude-code/test/fixtures
node packages/adapter-claude-code/src/cli.ts install --port 48201   # alongside the pet's own hooks
# …work normally until a prompt, a new window, or a rate limit happens…
node packages/adapter-claude-code/src/cli.ts uninstall --port 48201
```

Both hook sets coexist: `isOurs` matches on the URL, so installing a second port
adds to the first rather than replacing it.
