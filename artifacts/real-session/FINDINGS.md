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
| `401 authentication_error` | *recorded here as "failed immediately"* | `UserPromptSubmit`, `SessionEnd` |

**No `StopFailure` in either case.** The turn failed and the session simply ended.

> **Corrected below.** "Failed immediately" was wrong, and it mattered: a `401`
> is retried ten times at sixty-second intervals, exactly like the `429`. Both
> runs were abandoned inside the backoff window, so neither had reached a
> terminal failure when it was called a result. See
> [why every previous attempt saw nothing](#stopfailure-why-every-previous-attempt-saw-nothing).

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

---

# Interactive sessions, driven for real

Everything above was measured headless. Four hooks had never been seen, and the
conclusion recorded was "these need a human at a keyboard". That was true and it
was also an excuse: a keyboard can be simulated. `claude` under a pty is a real
interactive session — same binary, same UI, same code path — and it can be
driven from a script.

Fifteen sessions were run this way against a recorder on a second port.

## Two confounds, both of which would have produced a wrong answer

**The child-session marker.** The first pty run printed `⚠ Transcript saving is
off — inherited CLAUDE_CODE_CHILD_SESSION marker`. A session spawned from
inside another Claude Code session inherits `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and friends, and is
treated as a child rather than a new session. Measuring session *lifecycle*
hooks in a session the tool does not consider new is measuring nothing. Every
run below unsets all seven.

**Bracketed paste eats the Enter.** Two prompts appeared to be ignored — typed
into the input box, never submitted, no response for ninety seconds. They were
the two long enough to wrap onto a second line. Bracketed paste is on, so a
newline arriving in the same write as the text is inserted as a line break
instead of submitting. The text and the Enter have to be separate writes.

Both looked exactly like "the model did not do what I asked", which is the most
expensive kind of wrong: a plausible reading that ends the investigation.

## `SessionStart` is registered and never fires

Fifteen sessions. **Fifteen `SessionEnd`. Zero `SessionStart`.**

Not a subscription problem — it is in `hookConfig()` and it was live in
`settings.json` throughout, alongside `SessionEnd`, which arrived every time:

    Elicitation, ElicitationResult, Notification, PermissionDenied,
    PermissionRequest, PostCompact, PostToolUse, PostToolUseFailure, PreCompact,
    PreToolUse, SessionEnd, SessionStart, Stop, StopFailure, SubagentStart,
    SubagentStop, UserPromptSubmit

A hook we ask for, that its own sibling proves is wired correctly, that does not
exist. Claude Code 2.1.220.

The pet does not depend on it — a session registers on whatever arrives first,
usually `UserPromptSubmit` — so this costs nothing today. It is in the mapping
as an entry that can never execute.

## `PermissionDenied` never fires either, and that one costs something

Two independent denial paths, both silent.

**A human declining the dialog.** Esc at a Write permission prompt. The
rejection was real — `User rejected write to …`, and no file was created.

**A policy denial.** A project with `permissions.deny: ["Bash(curl:*)"]`. The
command was blocked and the model was told to use WebFetch instead.

Neither produced `PermissionDenied`. Across the whole run: 42 `PermissionRequest`
and not one `PermissionDenied`.

### What actually reaches the pet when you say no

Isolated to a throwaway project so the operator's own session could not pollute
it — the raw logger filtered on `cwd`:

    18:14:20  UserPromptSubmit
    18:14:24  PreToolUse         Bash
    18:14:24  PermissionRequest  Bash
    18:15:07  SessionEnd

Forty-three seconds between the tool starting and the session ending, and
**nothing in between**. No `PermissionDenied`. No `PostToolUse` — the tool never
ran, so nothing completed. No `Stop` — measured with a forty-second settle after
the decline, specifically to rule out a late arrival.

`PreToolUse` had already sent the pet to `working`. Nothing terminates it.

Note what is also absent: no `Notification` with `permission_prompt`. That is
the event that maps to `APPROVAL_NEEDED`, and it is how the pet is supposed to
know a human is being asked something. In this probe the dialog was on screen
and it did not arrive — so the pet was not even showing "May I?", it was
claiming to be busy. `Notification` did fire thirteen times elsewhere in the
run, from the operator's own concurrent session, so this is an observation
about this dialog rather than a claim that the hook is dead. It is the next
thing to isolate.

The machine's only way out is `WATCHDOG`, at `300_000` ms. So after the user
declines, **the pet spends five minutes insisting the agent is busy** — naming
the very tool that was refused — and then goes to `sleeping`, not `idle`,
because the watchdog treats silence as absence. The user is sitting right there,
having just pressed Esc.

This is the same failure the approval path already had and was fixed for:

> Granting permission produces no event of its own. A denial arrives as
> `APPROVAL_RESOLVED`; an approval arrives as nothing at all.
> — `petMachine.ts`, on the root `TOOL_DONE` transition

The first sentence is right. The second is now measured to be wrong: **a denial
also arrives as nothing at all.** The comment describes a hook that does not
fire, and the fix built on it covers only half the case it was written for.

Worth being precise about what is broken. The mapping is not wrong — if
`PermissionDenied` ever arrives it is handled correctly. What is wrong is that
the pet has no signal for "the tool is not going to happen", and it currently
gets that signal only by timing out.

## `StopFailure`: why every previous attempt saw nothing

The earlier headless runs reported "the client retried with backoff for over ten
minutes" and were stopped there. Driving it interactively put a number on it:

    ✻ API error · Retrying in 1m 0s · attempt 1/10

**Ten attempts, sixty seconds apart.** Every attempt against the local endpoint
was logged, so this is counted rather than inferred — ten `401`s served to one
prompt. A turn does not fail for roughly ten minutes, and `--mode auth`, chosen
precisely because a `401` is not a retryable condition in any useful sense, is
retried exactly like a `429`.

That is the whole explanation for the earlier null results. Every attempt so far
had been abandoned inside the backoff window, and "no `StopFailure`" meant "no
verdict yet" — a null reported as a finding.

Left to run past the tenth retry, it fired.

    [record] StopFailure #1 -> test/fixtures/StopFailure-1.json

**`exhausted` has an input.** The state §7.1 calls the highest-value in the
product, unreached since M0, now has a payload recorded from a real client
against a real failure. It needed no quota and no account — only the patience
to sit through ten minutes of backoff that every previous attempt had walked
away from.

### And the payload does not have the field the mapping reads

```json
{
  "hook_event_name": "StopFailure",
  "session_id": "…", "cwd": "…", "prompt_id": "…",
  "effort": { "level": "…" },
  "error": "<redacted:string:21>",
  "last_assistant_message": "<redacted:string:33>"
}
```

No `error_type`. The mapping does this:

```ts
const key = typeof raw.error_type === "string" ? raw.error_type : "unknown";
return [{ type: "AGENT_BLOCKED", reason: BLOCK_REASONS[key] ?? "unknown" }];
```

So every genuine block resolves to `unknown`, and `BLOCK_REASONS` — eight
entries mapping `rate_limit`, `overloaded`, `billing_error`,
`authentication_failed` and the rest onto the reason the pet reports — is
unreachable. It was written from documentation at M0, has only ever been
exercised by payloads we wrote ourselves, and has been wrong the entire time.

This is precisely the thing §11.1 says recording exists to catch, and it took
the first real payload to catch it. One fixture, one dead table.

Pinned as a test rather than fixed on the spot. The real payload carries `error`
as free text, and what that string actually contains is being captured
separately — guessing a parse from one redacted sample is how the `error_type`
table got here in the first place.

## Elicitation, deliberately not attempted

Both need an MCP server that asks for input mid-turn, and none of the servers
already configured here does. Standing one up would produce a fixture from a toy
built to trigger the hook, which is the thing recording exists to avoid.

## What this changes

Two of the five hooks the mapping registers for appear not to exist in Claude
Code 2.1.220. The third, `StopFailure`, does exist and was simply never waited
for. Two things follow.

**The pet has no signal for "this tool is not going to happen."** It is not
missing a hook; the hook it was written against does not fire. The five-minute
watchdog is currently the entire recovery path, and it recovers to `sleeping`.
Fixing it needs a decision, not a patch, because the only agent-agnostic signal
available is time, and a long build is indistinguishable from a refused command
by duration alone. Recorded here rather than guessed at.

**`exhausted` is reachable, and it cannot say why.** The state has its first
real input, and the same payload shows the reason table feeding it has never
been able to match. Fixing that needs to know what `error` contains, which is
one more capture rather than one more guess.

---

# TZX-96: the two fields that were there all along

The denial bug above was written up as needing a decision rather than a patch,
on this reasoning:

> The only agent-agnostic signal left is time, and a long build is
> indistinguishable from a refused command by duration alone.

That was wrong, and it was wrong the same way the `error_type` table was wrong:
a claim about a payload, made without looking closely enough at the payload.

## `permission_suggestions` distinguishes a question from an auto-approval

The mapping's own comment said it could not:

> Nothing in the payload distinguishes "auto-allowed" from "asking the user":
> `permission_mode` is the session's mode, and `permission_suggestions` is
> present either way. So this event cannot carry the meaning on its own.

Presence is indeed useless — the key is there both times. **Length is not.**

| | hook sequence | `permission_suggestions` |
| :-- | :-- | :-- |
| auto-approved (`acceptEdits`, in-project write + read) | `PreToolUse → PostToolUse → … → Stop` | no `PermissionRequest` at all |
| auto-approved (`acceptEdits`, evaluated) | `PreToolUse → PermissionRequest → PostToolUse` | `[]` |
| prompting (`default`, write outside the workspace) | `PreToolUse → PermissionRequest → (dialog)` | `[{setMode}, {addDirectories}]` |

Those are the dialog's own options — "switch mode", "add this directory",
"always allow this rule". Claude Code has no reason to compute them for a call
it is about to wave through.

So `PermissionRequest` maps to `APPROVAL_NEEDED` **when and only when it carries
suggestions**. The pet now says "May I?" while the dialog is up, instead of
naming the command as though it were running. Both historical bugs are covered
by one condition, and both committed fixture shapes are the regression test —
verified by breaking the mapping in each direction and watching the opposite
test go red.

## `StopFailure.error` is a `BLOCK_REASONS` key verbatim

The redacted fixture read `"error": "<redacted:string:21>"`. Unredacted:

```json
"error": "authentication_failed",
"last_assistant_message": "Not logged in · Please run /login"
```

`authentication_failed` is already in `BLOCK_REASONS`, mapping to `auth`. The
table was right about the vocabulary and the lookup was right about the meaning.
Only the field name was wrong — `error`, not `error_type` — and that one
mismatch made all eight entries unreachable from M0 until now.

**Redaction was hiding the answer.** `error` was replaced along with every other
free-text value, which is why the first capture proved the field existed and
told us nothing about it. It is now kept when the value looks like a bare
lower-snake identifier and still hidden when it is prose — because the same key
on `PostToolUseFailure` holds a tool's error message, which can contain absolute
paths. The test is on the value, not the key, so the redactor still needs to
know nothing about the schema.

## What this says about the method

Three findings in this file were "impossible" until someone read one level
deeper: `is_error` (documented, absent), `error_type` (expected, actually
`error`), and `permission_suggestions` (dismissed as present-either-way,
actually empty-or-not). Each was recorded as a limit of the data rather than a
limit of the reading.

A null result about a payload deserves the same suspicion as a null result about
a test: the first question is whether the instrument was pointed at the right
thing.

---

# TZX-97: the pet was invisible because the page was too transparent

The window was never the problem. I spent a day proving things about it.

## What it was

A fully transparent page makes WKWebView composite **none of the layer**. Not
"the transparent parts" — none of it. The opaque sprite and the dark speech
bubble were dropped along with the empty space.

Measured by capturing the window by id, which is the only capture that ignores
which Space is active:

| `.pet-root` background | alpha extrema | what appears |
| :-- | :-- | :-- |
| `transparent` | `(0, 0)` | nothing, not one painted pixel |
| `rgba(0,0,0,0.01)` | `(3, 255)` | the pet and the bubble |

`#ff0000` was the experiment that found it. A solid red root rendered the
penguin and "Nghỉ tí…" perfectly — which is what finally ruled out the window,
the Space, the level, the NSPanel conversion, and everything else.

The fix is one declaration: `rgba(0, 0, 0, 0.01)`, alpha 3/255, about 1 % black
over a 420x430 rectangle. Below the threshold of noticing, and the smallest
value that survives rounding.

## The symptom I mistook for the cause

`kCGWindowIsOnscreen` was absent, and the window was in the onscreen list only
0–12 % of the time. I treated that as the bug and tested six hypotheses against
it: the saved position, the walk, the NSPanel re-class, the window level,
applying the collection behaviour before `show()`, and activating the app. All
six refuted.

After the fix, the same measurement reads **100 %**. The window server does not
count a window whose layer has nothing composited in it. *Not onscreen* was
downstream of *nothing painted* the entire time, and I had the arrow backwards
for a day.

## Three instruments, three artefacts

Every measurement I took from outside the process was wrong in its own way, and
each one produced a confident false conclusion before it was caught.

**`screencapture` only sees the active Space.** So a full-screen capture of a
window on another Space looks exactly like a window that draws nothing.

**A differential screenshot needs a static background.** Diffing against a live
terminal measured the terminal: the control rectangle changed *more* than the
pet's, 11.7 % against 7.1 %, which is the control correctly announcing that the
measurement was meaningless. `fullscreen.py` works only because TextEdit holds
still.

**Reading the window rect then screenshotting races the walk**, which moves the
window every 900 ms — so the crop can land where the window used to be.

And the AppKit reads I added to replace them had an artefact too: `occlusion`
returned `0x2000` for our window *and* for both `NSStatusBarWindow`s, which are
plainly working. `isOnActiveSpace` was `false` for those as well. Enumerating
every window the app owns was what exposed it — two known-good windows in the
same process, read the same way, giving the same meaningless answer. That
control should have existed before any of those readings was believed.

## The test, which first could not fail

The guard is a stylesheet assertion, because jsdom composites nothing. Its first
version matched the *comment* explaining the rule — the comment contains
`background: rgba(0,0,0,0.01)` as example text — so it passed with the real
declaration deleted. A test satisfied by its own documentation is worse than no
test. It now strips comments before matching, and fails both ways: declaration
removed, and alpha raised to something a user would see.

## What this cost, and what it is worth

Six refuted hypotheses, two claims built on two coincidences each, one macOS
change committed and reverted, and a build measured against a binary that had no
frontend in it because `cargo build --release` loads `devUrl` — a trap this
repository already warns about in a comment.

The finding underneath all of it: **a null result about a payload or a pixel
deserves the same suspicion as a null result about a test.** The first question
is never "why is it broken", it is "is the instrument pointed at the thing".
