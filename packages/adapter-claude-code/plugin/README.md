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
costs nothing measurable. Measured delta with the pet running versus killed: **0.21 ms**.

## Moving the port

The endpoint is baked into the URLs below, so `PET_PORT` needs the hooks regenerated:

```
node packages/adapter-claude-code/src/cli.ts doctor --port 49000
```

The pet refuses to start on a busy port rather than quietly choosing another one, for the
same reason: hooks point at a URL, and a silent move is a pet that stops reacting with no
error anywhere.
