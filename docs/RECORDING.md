# Recording the last five hooks

Thirteen of the sixteen hooks in `mapping.ts` have fixtures recorded from a live
agent. Three do not, and the reasons differ — two of them are not "yet to be
captured" but **measured not to fire at all**.

That is a narrower statement than it sounds, and it is measured rather than
assumed — see [`artifacts/real-session/FINDINGS.md`](../artifacts/real-session/FINDINGS.md).

| Hook | Why it has never been captured |
| :-- | :-- |
| `SessionStart` | **does not fire.** 15 interactive sessions: 15 `SessionEnd`, 0 `SessionStart`, both registered side by side |
| `PermissionDenied` | **does not fire**, on either path — a human pressing Esc, or a `permissions.deny` rule. 42 `PermissionRequest`, 0 `PermissionDenied` |
| ~~`StopFailure`~~ | **captured** — see below |
| `Elicitation` | needs an MCP server that asks for input mid-turn |
| `ElicitationResult` | same, plus a reply |

`test/fixtures.test.ts` holds this same list. Recording a fixture and forgetting
to remove its entry is a test failure, so the list cannot quietly go stale.

## The recorder runs *alongside* the pet

It does not take your pet away. `installHooks` only replaces entries whose URL
matches its own port, so the recorder's hooks at `48201` and the pet's at
`48200` both fire, and `--install` removes only its own on exit.

```sh
cd packages/adapter-claude-code
node --experimental-strip-types src/cli.ts record --install \
  --only SessionStart,PermissionDenied,StopFailure,Elicitation,ElicitationResult
```

Two flags matter and both default to the safe thing:

* `--only` — everything else is answered `204` and dropped. Without it, three
  `PreToolUse` payloads from the first ten seconds fill the slots and the run
  captures nothing you were waiting for.
* no `--force` — a fixture that already exists is never overwritten. The
  default output directory is `test/fixtures`, so without this a capture run
  silently replaces files that were recorded, redacted and reviewed months ago.

Redaction is on: keys survive, free-text values become
`<redacted:string:N>`, and paths and session IDs become placeholders. Check a
file before committing anyway.

Stop with ctrl-c. The hooks come out with it.

## Provoking each one

### `SessionStart` — free

Start an interactive `claude` in any project. That is the whole test. If this
does not appear, that is itself the finding, and a bigger one than the fixture.

### `PermissionDenied` — one keystroke

Ask for something that needs approval and **decline it**:

> run `rm -rf /tmp/agent-pet-probe`

When the permission prompt appears, choose no. Note that `PermissionRequest`
fires on every permission *evaluation*, including auto-approved ones — that is
why it maps to `[]` — so the denial is the only part that produces a new event.

### `StopFailure` — a server that always fails

**Captured.** The thing that had defeated three previous attempts was patience,
not access: Claude Code retries every API error **ten times at sixty-second
intervals**, including a `401`, so a turn does not reach a terminal failure for
roughly ten minutes. Every earlier run was abandoned inside that window, and
"no `StopFailure`" meant "no verdict yet".

```sh
python3 tools/record/failing-api.py --mode rate_limit
```

Then, in another terminal:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:48260 claude
```

Send one prompt, then **wait out the full ten retries** — around twelve minutes.
`--mode auth` is retried just like `rate_limit`, so it is no faster; pick
whichever reason you want in the fixture.

The payload it produced carried `"error": "authentication_failed"` — a
`BLOCK_REASONS` key verbatim, under a field name the mapping was not reading.
That one mismatch had made all eight entries unreachable since M0.

### `Elicitation` / `ElicitationResult` — hardest

These need an MCP server that elicits input mid-turn. If none of the servers
you already run does that, leave these two; they are the least valuable of the
five, and inventing an MCP server to trigger them would produce a fixture from
a toy rather than from real use, which is the thing recording exists to avoid.

## Afterwards

1. Read every new file. Redaction is mechanical and cannot know what is
   sensitive in a value it kept.
2. Delete that hook's entry from `UNCAPTURED` in `test/fixtures.test.ts`.
3. `pnpm verify`. The fixture is now held to the same mapping, required-field
   and envelope assertions as the other twelve, and `EXPECTED` says which event
   it must produce — so a fixture that disagrees with the mapping fails here.
