# Agent Pet

A desktop pet that is the embodiment of a running AI coding agent. It digs while the agent runs a shell command, types while it edits files, waves when it needs your approval, and goes flat when the agent is rate-limited.

**It is a glanceable status display disguised as a toy.** Every design decision is measured against one test: can you tell, in a 200 ms glance and without reading text, whether the agent is busy, waiting on you, or broken?

> **Status: M2.** The loop works end to end — a hook payload changes what the pet draws — and it installs as a plugin. Not yet released: no signed build, and the default pet is placeholder art.

## What is here today

| Package | State | What it does |
| :-- | :-- | :-- |
| `packages/protocol` | ✅ | `PetEvent` wire format and the `PetAdapter` contract. Versioned from day one. |
| `packages/adapter-claude-code` | ✅ | Every piece of Claude Code knowledge in the project: 11 hook events → `PetEvent`, tool classification, the plugin, and `install`/`uninstall`/`doctor`/`record`. |
| `packages/pet-core/src/packs` | ✅ | Atlas geometry and the state → animation-row map, both derived empirically in Spike D. |
| `packages/pet-core` (rest) | ✅ | Tauri shell, HTTP server, xstate machine, session registry, renderer, tray, demo mode. |

## Platforms

| | |
| :-- | :-- |
| **macOS**, **Windows** | Phase 1 targets. |
| **Linux · X11** | Best-effort. |
| **Linux · Wayland** | Likely unsupported — Wayland gives a client no way to position its own window or force always-on-top. Being settled by a spike; no support is claimed until it is. |
| **iOS / Android** | Out of scope, and not for the obvious reason: the agent runs on your desktop, so a phone cannot receive its hooks at all. The honest mobile shape is a remote notifier over the Phase 3 protocol, not an overlay pet. |

Everything shipped so far is pure TypeScript with no OS assumptions — the platform surface is entirely in the Tauri shell, which is still M1 work. See spec §3.1.

## Install

```
/plugin marketplace add TrizenX/agent-pet
/plugin install agent-pet@trizenx
```

Then start the pet. Not sure whether it worked:

```
node packages/adapter-claude-code/src/cli.ts doctor
```

`doctor` exists because all three ways this setup fails are silent — the pet is not running, the hooks are not installed, or they point at a port nothing is listening on. None of them produce an error anywhere; the pet simply never reacts.

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
