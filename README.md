# Agent Pet

A desktop pet that is the embodiment of a running AI coding agent. It digs while the agent runs a shell command, types while it edits files, waves when it needs your approval, and goes flat when the agent is rate-limited.

**It is a glanceable status display disguised as a toy.** Every design decision is measured against one test: can you tell, in a 200 ms glance and without reading text, whether the agent is busy, waiting on you, or broken?

> **Status: M6.** Driven by real agent sessions and by `git`, with two adapters feeding one pet. **Not released:** there is no signed build, so today you build it yourself — see below. The bundled pet is placeholder art; the four thousand community packs are one tray menu away.

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

Two halves: **the pet**, which is an app you run, and **the hooks**, which tell it what your agent is doing. Neither works without the other, and both fail silently, which is why there is a `doctor`.

### 1 · Build and run the pet

There is no signed release yet, so you build it. macOS, and you will need [Rust](https://rustup.rs) and Node 20+.

```sh
git clone https://github.com/TrizenX/agent-pet && cd agent-pet
corepack enable && pnpm install
pnpm --filter @agent-pet/pet-core tauri build --no-bundle
./packages/pet-core/src-tauri/target/release/agent-pet &
```

A pet appears in the bottom-right corner, asleep. It lives in the tray from here — size, pack, click-through, language.

> `cargo build --release` on its own is **not** enough: Tauri decides dev-versus-production from how `tauri-build` was invoked, not from the cargo profile, so that binary loads a dev server that is not running and shows an empty window.

### 2 · Point an agent at it

```
/plugin marketplace add TrizenX/agent-pet
/plugin install agent-pet@trizenx
```

Hooks are read when a session starts, so **open a new one** — the session you ran that in keeps the hooks it started with.

For `git`, run this **inside a repository** to have commits, pushes and rebases drive the pet too:

```sh
node packages/adapter-git/src/install.ts install
```

Per repository, because that is where git hooks live. It never replaces a hook it did not write — an existing `pre-commit` is left exactly as it is and reported, because nothing here is worth breaking one for.

### 3 · Check it

```sh
node packages/adapter-claude-code/src/cli.ts doctor
```

```
endpoint  http://127.0.0.1:48200/event/claude-code
pet       running
          webview connected, 3 session(s)
plugin    installed
hooks     none in /Users/you/.claude/settings.json

Set up. New sessions will drive the pet.
```

`doctor` exists because all three ways this setup fails are silent — the pet is not running, the hooks are not installed, or they point at a port nothing is listening on. None of them produce an error anywhere; the pet simply never reacts.

If you would rather not install a plugin, `pet-adapter install` writes the same hooks into `~/.claude/settings.json` and keeps a backup. `pet-adapter uninstall` removes exactly its own entries and leaves yours alone.

## Read this first

- **[`PET_PROJECT_SPEC.md`](PET_PROJECT_SPEC.md)** — the single source of truth. §2 lists the hard invariants; §13 lists decisions that are already closed.
- **[`artifacts/spike-d/FINDINGS.md`](artifacts/spike-d/FINDINGS.md)** — M0 Spike D: how the sprite atlas layout was derived from real sheets, and the two spec corrections it forced.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — event flow and how to add an adapter.
- **[`docs/PET_PACKS.md`](docs/PET_PACKS.md)** — authoring a pack: which atlas rows the pet actually uses.
- **[`docs/IP_POLICY.md`](docs/IP_POLICY.md)** — we render other people's pets and never redistribute them.
- **[`docs/RELEASE.md`](docs/RELEASE.md)** — what blocks a release, separated from what is merely undone.

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

**We render other people's pets; we never redistribute them.** The packs come from community galleries whose contents are user-submitted fan art with disclaimed IP. Rendering a file a user installed is not distributing it — committing one would be. That rule does not depend on the app being free: being the distributor is a different position from being a renderer, and this repo is MIT, so it cannot carry art we do not own. See [`docs/IP_POLICY.md`](docs/IP_POLICY.md).

## Licence

MIT for the code. Art assets are covered separately — see §17.2 of the spec.
