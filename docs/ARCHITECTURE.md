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

## The response path is deliberately empty

`POST /event/:source` does four things and nothing else: check the headers, copy the body into a bounded queue, increment a counter, return `204`. It does not parse JSON, does not touch the webview, and does not wait on any consumer.

That shape is what makes the two hard invariants structural rather than aspirational:

- **I1** — there is no code path that can return anything but `204` to a hook, because there is no code that inspects the body. Malformed input cannot produce a `400`, because nothing tries to read it.
- **I2** — the work the agent waits for is a header check and a `memcpy`. Parsing, adapter mapping, session routing and rendering all happen on the far side of the queue, on a task the agent never blocks on.

### Why the body limit is 1 MB and not 8 KB

The spec originally said "reject bodies > 8 KB with `413`". Implementing it showed the rule contradicts I1: a `PostToolUse` payload embeds the tool's *entire* response, so a `Read` of a large file or a chatty command produces hundreds of kilobytes of perfectly legitimate hook traffic. Rejecting it would mean answering a genuine hook with a non-`204`.

So the hard limit moved to 1 MB — high enough that no real hook trips it, low enough to refuse something pathological — and the protection that actually matters moved to the queue, which is bounded by **both** item count (1 000) and total bytes (8 MB).

The byte bound is not redundant. A thousand-entry queue holding 300 KB payloads is 300 MB; count alone does not bound memory when one event can be large. When either bound is hit the **oldest** entries are shed, because a pet showing stale state is worse than a pet that skipped a frame.

### The browser lockout

The guard refuses any request carrying `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Mode`. Browsers always send at least one; hooks never do. Page script cannot suppress them — they are forbidden header names.

One rule, no configuration, and it closes the whole "any web page can POST to your loopback port" vector. The optional `PET_TOKEN` is hardening on top, not the primary defence.


## Running it

```sh
pnpm install
pnpm --filter @agent-pet/pet-core dev      # vite + tauri together
```

A **debug** build loads `devUrl` (the Vite dev server), not `frontendDist`. Running `cargo run` on its own therefore shows an empty window with no error anywhere, because the shell is pointed at a server nobody started — the symptom is indistinguishable from a crashed renderer. Either use `pnpm dev`, or start `pnpm dev:vite` first.

The shell prints the URL it resolved at startup for exactly this reason.

### Seeing inside the webview

A transparent, undecorated overlay has nowhere to show a failure: a broken frontend and a working one both look like an empty screen. `webview_log` bridges `console.*` and unhandled errors to the shell's stdout, installed on `on_page_load` — installing it during `setup` does not work, because `eval` there runs against whatever document exists at that moment and is discarded on navigation.
