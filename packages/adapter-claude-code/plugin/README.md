# agent-pet plugin

Points this session's hooks at a locally running Agent Pet.

```
/plugin marketplace add TrizenX/agent-pet
/plugin install agent-pet@trizenx
```

## What it does to your session

Nothing, by design. Every hook is an HTTP POST to `127.0.0.1:48200` with a two-second
timeout, and the pet answers `204` with an empty body — a hook response body can block a
tool call, so the pet's server has no code path that reads the request or produces a
decision (spec invariant I1).

If the pet is not running, the connection is refused instantly on loopback and the hook
costs nothing measurable. Measured round-trip with the pet running: **0.16 ms**; with it killed, 0.11 ms to be
refused. (An earlier 0.21 ms figure was `curl` startup, not the endpoint.)

## Moving the port

The endpoint is baked into the hook URLs, so a non-default `PET_PORT` needs a different
block. `doctor` prints the right one and tells you what is currently wired:

```
node packages/adapter-claude-code/src/cli.ts doctor --port 49000
```

The pet refuses to start on a busy port rather than quietly choosing another one, for the
same reason: hooks point at a URL, and a silent move is a pet that stops reacting with no
error anywhere.
