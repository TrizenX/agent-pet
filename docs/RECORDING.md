# Recording the last five hooks

Twelve of the sixteen hooks in `mapping.ts` have fixtures recorded from a live
agent. Five do not, and every one of them is missing for the same reason: **a
headless `claude -p` run does not emit them.** They need a person at a keyboard.

That is a narrower statement than it sounds, and it is measured rather than
assumed — see [`artifacts/real-session/FINDINGS.md`](../artifacts/real-session/FINDINGS.md).

| Hook | Why it has never been captured |
| :-- | :-- |
| `SessionStart` | never observed headless |
| `PermissionDenied` | needs a human declining a prompt |
| `StopFailure` | needs a turn that fails against the API |
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

The open question. Headless, a real `429` produced no `StopFailure`; the turn
simply failed and the session ended. Whether interactive differs is unknown.

```sh
python3 tools/record/failing-api.py --mode rate_limit
```

Then, in another terminal:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:48260 claude
```

Send one prompt. Every response fails, so nothing else can happen. `--mode auth`
fails instantly instead of retrying with backoff, which is quicker if all you
want is the list of hooks that fire.

**Either outcome is a result.** A fixture, or confirmation that `StopFailure`
does not exist on this path — in which case `exhausted` is unreachable as
designed and that needs saying in the spec, not leaving as a TODO.

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
