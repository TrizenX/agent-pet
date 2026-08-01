# Architecture

## Event flow

```
Claude Code ──HTTP hook──▶ POST /event/claude-code          raw agent payload
                              │  guard.rs: ≤8 KB, no Origin, loopback only
                              │  ── 204 No Content, immediately ──▶ agent continues
                              ▼
                           bounded channel (never blocks the response)
                              │
                              ├─ Tauri event "agent-raw" { source, payload, at }
                              ▼
React  useAgentEvents ──▶ adapters/registry.ts ──▶ adapter.toPetEvents(payload)
                              ▼                        PetEvent[]
                       sessions/registry.ts        per-session actors, focus policy
                              ▼
                       machine/petMachine.ts       focused session only
                              ▼
                       <Pet/> + <StateGlyph/>      atlas row + overlay
```

Two properties this shape exists to guarantee:

- **I1 — the pet never changes agent behaviour.** A hook's response body can block a tool call or inject context. The server answers `204` with an empty body, always, before doing any work.
- **I2 — the pet never slows the agent.** HTTP hooks are synchronous; the agent waits up to `timeout`. Connection-refused on loopback returns in microseconds, so a *stopped* pet costs nothing. A *hung* pet is what the respond-first design prevents.

## Adding an adapter

1. Create `packages/adapter-<agent>/` exporting a `PetAdapter` from `./mapping`.
2. `toPetEvents` must be **pure** — no I/O, no clock, no randomness. It receives `receivedAt` in its context. Purity is what lets the mapping be table-tested against payloads recorded from a live agent, which is the only defence against a hook schema that keeps changing.
3. Add one line to `packages/pet-core/src/adapters/registry.ts`.
4. Point the agent's hooks at `POST /event/<your-adapter-id>`.

Nothing else in `pet-core` changes. `pnpm lint:no-agent-strings` enforces that.

## Why classification lives in code, not in hook config

Hooks *could* narrow by matcher — `"matcher": "Bash"` for one endpoint, `"Edit|Write"` for another. We deliberately register the broadest matcher and classify in `tools.ts` instead:

- Overlapping matchers double-fire. `Bash` and `.*` both match `Bash`, producing two events per tool call.
- Regexes in a JSON config cannot be unit-tested, and they scatter agent knowledge across a file that is not part of any package.
- New tools appear constantly. A default-to-`other` function degrades gracefully; a config file silently stops matching.

## The pet atlas format

`pet-core` renders a community sprite-atlas format: an 8-column grid of 192×208 frames, 9 rows (v1, 1536×1872) or 11 rows (v2, 1536×2288). The format originated in ChatGPT.app's pet feature and is carried by the Petdex gallery and its downstream projects. We adopted it rather than inventing one — see spec D10.

Upstream publishes row *names* but not row *order* or frame counts. Both were derived empirically in [M0 Spike D](../artifacts/spike-d/FINDINGS.md); `packages/pet-core/src/packs/atlas.ts` is the encoded result. Two findings drive the code:

- **Row order is stable** across sheets and both versions — safe to hardcode as an enum.
- **Frame counts are per-sheet, not per-format** — some pets pad every row to 8 by repeating frames. The loader counts live frames at load time and never assumes.

Provenance is documented here rather than in `atlas.ts` because `pet-core` must not name any agent's ecosystem (I5). To that file, this is just an art format.
