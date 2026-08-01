# Agent Pet

A desktop pet that is the embodiment of a running AI coding agent. It digs while the agent runs a shell command, types while it edits files, waves when it needs your approval, and goes flat when the agent is rate-limited.

**It is a glanceable status display disguised as a toy.** Every design decision is measured against one test: can you tell, in a 200 ms glance and without reading text, whether the agent is busy, waiting on you, or broken?

> **Status: pre-M1.** The workspace, the wire protocol, the Claude Code mapping and the atlas layout are in place and tested. The Tauri shell, the state machine and the renderer are M1 work. Nothing here is installable yet.

## What is here today

| Package | State | What it does |
| :-- | :-- | :-- |
| `packages/protocol` | ✅ | `PetEvent` wire format and the `PetAdapter` contract. Versioned from day one. |
| `packages/adapter-claude-code` | ✅ mapping · ⏳ CLI | Every piece of Claude Code knowledge in the project: 11 hook events → `PetEvent`, plus tool classification. 41 tests. |
| `packages/pet-core/src/packs` | ✅ | Atlas geometry and the state → animation-row map, both derived empirically in Spike D. |
| `packages/pet-core` (rest) | ⏳ M1 | Tauri shell, HTTP server, xstate machine, renderer, tray. |

## Read this first

- **[`PET_PROJECT_SPEC.md`](PET_PROJECT_SPEC.md)** — the single source of truth. §2 lists the hard invariants; §13 lists decisions that are already closed.
- **[`artifacts/spike-d/FINDINGS.md`](artifacts/spike-d/FINDINGS.md)** — M0 Spike D: how the sprite atlas layout was derived from real sheets, and the two spec corrections it forced.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — event flow and how to add an adapter.

## Develop

```sh
pnpm install
pnpm verify        # typecheck + lint + I5 check + tests
pnpm test:watch
```

Requires Node 20+ and pnpm 10. Rust is only needed once the Tauri shell lands in M1.

Reproduce the atlas spike (downloads sheets to a scratch dir, commits nothing):

```sh
pip install Pillow
python3 tools/spike-atlas/derive_atlas.py --out artifacts/spike-d --work /tmp/spike-d
python3 tools/spike-atlas/verify_rows.py  --out artifacts/spike-d --work /tmp/spike-d
```

## Two rules that shape the codebase

**I5 — `pet-core` names no agent.** Exactly one file, `packages/pet-core/src/adapters/registry.ts`, may import an adapter. `pnpm lint:no-agent-strings` fails the build otherwise. Supporting a second agent is meant to be one line there and nothing else.

**Art licensing.** The pet packs this app renders come from a community gallery whose contents are user-submitted fan art with disclaimed IP. We render other people's pets; we never bundle, mirror, or redistribute them, and only original licence-cleared art ever ships in a release. See spec §17.2.

## Licence

MIT for the code. Art assets are covered separately — see §17.2 of the spec.
