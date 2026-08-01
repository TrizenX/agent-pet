# Agent Pet — Project Specification

**Version:** 2.1 · **Status:** ready to implement · **Scope of this document:** Phase 1 + Phase 1.5

> **How to use this file.** This is the single source of truth. Implement §3–§12 exactly. Anything marked *(later)* must NOT be built now, but the structure must leave room for it. §2 lists **hard invariants** — a change that violates one is a bug, not a trade-off. §13 records decisions that are already closed: do not re-litigate them.

---

## 1. Product

A desktop pet that lives on top of every window and is the **embodiment of a running AI coding agent**. Instead of a spinner in a terminal, the user sees a creature that reacts in real time:

| The agent… | The pet… |
| :-- | :-- |
| starts a session | wakes up |
| receives a prompt | perks up, attentive |
| runs a shell command | digs |
| edits or writes files | hammers / types |
| reads or searches code | sniffs around |
| needs a permission decision | drops everything, waves, glows |
| hits a rate limit / billing error | goes flat and exhausted |
| fails a tool call | falls over |
| finishes real work | carries a trophy back and celebrates |
| goes quiet | yawns, then sleeps |

### 1.1 The one-sentence product thesis

**Agent Pet is a glanceable status display disguised as a toy.** Every design decision is measured against a single test: *can the user tell, in a 200 ms glance and without reading text, whether the agent is busy, waiting on them, or broken?*

That test is the tiebreaker for every UX argument in this document. It promotes things that look boring (a distinct "rate-limited" pose) and demotes things that look fun (the pet sprinting across the screen).

### 1.2 Phase roadmap

- **Phase 1 (NOW):** agent pet driven by Claude Code hooks. One machine, one pet, many concurrent sessions.
- **Phase 1.5 (NOW-ish, after M2 passes):** pet packs — compatible with the existing Petdex/Codex atlas format, so the thousands of pets already in the wild work on day one (§12, D10).
- **Phase 2 *(later)*:** git-activity adapter (pet grows / sickens with commit activity).
- **Phase 3 *(later)*:** sync layer + an open **Pet Protocol** so pets from different tools and machines interact.

The architecture is adapter-based so Phase 2 and 3 are pure additions. The Phase 3 protocol is the actual moat — Phase 1 hooks are a public API anyone can reimplement in a weekend. Every wire format in this spec is therefore versioned from day one.

---

## 2. Hard invariants

These are non-negotiable. Each has an owning test (§11).

| # | Invariant | Why |
| :-- | :-- | :-- |
| **I1** | **The pet never changes agent behaviour.** Every hook response is `204 No Content` with an empty body. | A hook response body can block tool calls or inject context. A pet that silently blocks a `Bash` call is a catastrophic bug. |
| **I2** | **The pet never slows the agent.** Hook handling is measured in single-digit milliseconds; a dead, hung, or crashed pet costs the agent ≤ 2 s once, and ≤ 0 ms when not running. | The moment the pet taxes the agent, it is deleted. |
| **I3** | **Events preempt animations, always.** A new event cuts the current animation on the same frame. No state — including `celebrating`, `error`, and `exhausted` — can swallow an incoming event. | The pet must never lag behind reality; a lagging pet is worse than no pet. |
| **I4** | **No state is terminal.** Every state has a timeout decay path toward `idle` → `sleeping`, plus a global watchdog. A missed hook can never wedge the pet. | Hooks get missed. Sessions get `kill -9`'d. |
| **I5** | **`pet-core` contains zero hardcoded agent knowledge.** Exactly one file — `src/adapters/registry.ts` — may name an adapter. No other file in `pet-core` may contain the string `claude`, a Claude Code tool name, or a hook event name. | This is what makes Phase 2 an addition rather than a rewrite. Enforced by a lint test. |
| **I6** | **Idle cost is zero.** While `sleeping`, the app performs no animation, no timers faster than 1 Hz, and no repaints. Measured CPU ≈ 0.0 %. | An always-on-top transparent window that composites continuously eats laptop battery. This is the #1 uninstall reason for overlay apps. |
| **I7** | **The event wire format is versioned and source-tagged.** Every `PetEvent` carries `v` and `source`. | Phase 3 is a protocol. Protocols without version fields die. |

---

## 3. Tech stack

| Layer | Choice | Notes |
| :-- | :-- | :-- |
| Desktop shell | **Tauri 2** | Transparent, always-on-top, click-through; small binary; low RAM |
| Backend | Rust — Tauri core + **axum** on the existing tokio runtime | Tauri already runs tokio; no second runtime |
| Frontend | **React + TypeScript + Vite** | |
| State machine | **xstate v5** | Declarative `after` timers are the reason; the machine is the most-tested unit in the repo |
| Rendering | Sprite sheet (PNG) + CSS `steps()` | No canvas, no PixiJS |
| Packaging | pnpm workspaces | |

**Target OS (Phase 1):** macOS + Windows. Linux best-effort, not gated in CI.

---

## 4. Monorepo layout

```
agent-pet/
├── package.json                     # pnpm workspace root
├── pnpm-workspace.yaml
├── README.md                        # install & usage
├── PET_PROJECT_SPEC.md              # this file
│
├── packages/
│   ├── protocol/                    # ⭐ NEW — the wire contract, depended on by everyone
│   │   ├── package.json             #   @agent-pet/protocol
│   │   └── src/
│   │       ├── events.ts            #   PetEvent union + PET_EVENT_VERSION  (§6)
│   │       ├── adapter.ts           #   PetAdapter interface               (§5.2)
│   │       └── index.ts
│   │
│   ├── pet-core/                    # the pet runtime (Tauri app) — agent-agnostic
│   │   ├── src-tauri/
│   │   │   ├── Cargo.toml
│   │   │   ├── tauri.conf.json      #   transparent, decorations:false,
│   │   │   │                        #   alwaysOnTop, skipTaskbar, resizable:false
│   │   │   ├── src/
│   │   │   │   ├── main.rs          #   entry: single-instance guard, window, server, tray
│   │   │   │   ├── server.rs        #   axum on 127.0.0.1:$PET_PORT        (§5.1)
│   │   │   │   ├── guard.rs         #   request admission: size / origin / token  (§10)
│   │   │   │   ├── tray.rs          #   tray menu                          (§9.3)
│   │   │   │   ├── window.rs        #   click-through, spaces/fullscreen, position
│   │   │   │   │                    #   persistence, monitor-loss clamping (§9.1)
│   │   │   │   └── packs.rs         #   enumerate + validate pet packs     (§12)
│   │   │   └── icons/
│   │   │
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── adapters/
│   │   │   │   └── registry.ts      #   ⚠️ THE ONLY FILE THAT MAY NAME AN ADAPTER (I5)
│   │   │   ├── machine/
│   │   │   │   ├── petMachine.ts    #   xstate machine                     (§7)
│   │   │   │   └── guards.ts        #   celebrationWorthy, etc.
│   │   │   ├── sessions/
│   │   │   │   ├── registry.ts      #   sessionId -> live session state    (§8)
│   │   │   │   └── focus.ts         #   which session the pet is showing   (§8.2)
│   │   │   ├── components/
│   │   │   │   ├── Pet.tsx
│   │   │   │   ├── SpeechBubble.tsx
│   │   │   │   ├── Trophy.tsx
│   │   │   │   ├── SessionBadge.tsx #   "3" when >1 session is live
│   │   │   │   ├── StateGlyph.tsx   #   overlay glyph layer — ours, not the pack's (§9.5)
│   │   │   │   └── EventLog.tsx     #   debug window, last 200 events      (§11.3)
│   │   │   ├── packs/
│   │   │   │   ├── atlas.ts         #   Petdex/Codex atlas geometry + row enum (§12.1)
│   │   │   │   ├── stateMap.ts      #   PetState -> atlas row + fps + loop mode (§12.3)
│   │   │   │   ├── loader.ts        #   scan roots, validate, fallback merge  (§12.2)
│   │   │   │   ├── gallery.ts       #   petdex.dev manifest client (opt-in)   (§12.4)
│   │   │   │   └── default/         #   the built-in pet — itself a pack
│   │   │   │       ├── pet.json
│   │   │   │       ├── spritesheet.webp
│   │   │   │       └── strings.json #   our extension; optional for third-party packs
│   │   │   ├── demo/
│   │   │   │   └── scenarios.ts     #   scripted event streams             (§11.2)
│   │   │   ├── hooks/
│   │   │   │   └── useAgentEvents.ts
│   │   │   └── styles/pet.css
│   │   ├── index.html
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   └── adapter-claude-code/         # ALL Claude-Code knowledge lives here
│       ├── package.json             #   exports: "." (CLI) and "./mapping" (browser-safe)
│       ├── src/
│       │   ├── mapping.ts           #   raw hook JSON -> PetEvent[]  (pure, no I/O)  (§6.3)
│       │   ├── tools.ts             #   tool_name -> ToolKind classification
│       │   ├── cli.ts               #   pet-adapter <install|uninstall|doctor|record>
│       │   ├── install.ts           #   FALLBACK path only — settings.json merge (§5.4)
│       │   └── record.ts            #   capture real payloads as test fixtures (§11.1)
│       ├── plugin/                  #   ⭐ PRIMARY distribution
│       │   ├── plugin.json
│       │   └── hooks/hooks.json     #   the exact hooks block               (§5.3)
│       └── test/fixtures/           #   recorded payloads, committed
│
└── docs/
    ├── ARCHITECTURE.md              # event-flow diagram + "how to write an adapter"
    └── PET_PACKS.md                 # pack authoring guide (Phase 1.5)
```

**Change from v1:** `shared/` is replaced by a real `protocol/` package (the wire contract must be a dependency, not a placeholder), and `sprites/` is replaced by `packs/` because the built-in pet is a pack from day one — building it pack-shaped is cheaper than refactoring into packs later.

---

## 5. Event pipeline

### 5.1 Flow

```
Claude Code ──HTTP hook──▶ POST /event/claude-code        (raw agent payload)
                              │  guard.rs: ≤8 KB, no Origin, loopback, optional token
                              │  ── respond 204 IMMEDIATELY (I1, I2) ──▶ agent continues
                              ▼
                           channel (never blocks the response)
                              │
                              ├─ emit Tauri event "agent-raw" { source, payload, at }
                              ▼
React  useAgentEvents ──▶ adapters/registry.ts ──▶ adapter.toPetEvents(payload)  ──▶ PetEvent[]
                              ▼
                       sessions/registry.ts   (per-session state, focus policy §8)
                              ▼
                       machine/petMachine.ts  (focused session only)
                              ▼
                       <Pet/> plays the matching animation
```

**The Rust server does no interpretation.** It validates shape and size, tags the source, and forwards. All agent semantics live in the adapter.

### 5.2 The adapter contract

```ts
// packages/protocol/src/adapter.ts
export interface PetAdapter {
  /** Stable id; also the URL path segment: POST /event/<id> */
  readonly id: string;
  /** Human-readable, shown in the tray and /health */
  readonly label: string;
  /** Pure. No I/O, no clock, no randomness. May return 0..n events. */
  toPetEvents(raw: unknown, ctx: { receivedAt: number }): PetEvent[];
}
```

Purity is a hard requirement: it is what makes mapping table-testable against recorded fixtures (§11.1).

`pet-core/src/adapters/registry.ts` is the only file allowed to import a concrete adapter:

```ts
import type { PetAdapter } from "@agent-pet/protocol";
import { claudeCodeAdapter } from "@agent-pet/adapter-claude-code/mapping";

export const ADAPTERS: readonly PetAdapter[] = [claudeCodeAdapter];
```

Phase 2 adds one line here. Nothing else in `pet-core` changes. Invariant I5 is enforced by a test that greps the rest of `pet-core` for forbidden strings.

### 5.3 Hook registration — the one rule

> **Register the broadest matcher; classify in `mapping.ts`.**

Claude Code fires **every** matching hook entry, so narrow overlapping matchers (`Bash` *and* `.*`) would double-fire. More importantly, classification-in-JSON scatters agent knowledge across a config file where it cannot be tested. One `.*` entry per event, all interpretation in pure TypeScript.

`plugin/hooks/hooks.json` (verified against the current hooks reference):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "PreToolUse":         [{ "matcher": ".*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "PostToolUse":        [{ "matcher": ".*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "PostToolUseFailure": [{ "matcher": ".*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "PermissionRequest":  [{ "matcher": ".*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "PermissionDenied":   [{ "matcher": ".*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "Notification":       [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "Stop":               [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }],
    "StopFailure":        [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48200/event/claude-code", "timeout": 2 }] }]
  }
}
```

**Critical correction from v1:** the `http` hook type has **no `async` field** — that exists only on `type: "command"`. HTTP hooks are synchronous; the agent waits up to `timeout`. Hence `timeout: 2` and the respond-204-first design in §5.1. Connection-refused on loopback returns in microseconds, so a *stopped* pet costs nothing; only a *hung* pet costs 2 s, which the watchdog in §5.5 exists to prevent.

**Reserved for Phase 1.5** (do not register yet): `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`.

**Deliberately not used:** the `if` field (permission-rule syntax such as `"Bash(git *)"`). It would move classification back into JSON. Same reasoning as the one rule above.

### 5.4 Distribution: plugin first, `settings.json` as fallback

**Primary — Claude Code plugin.** Claude Code plugins ship hooks via `hooks/hooks.json`. Installing via `/plugin` gives us, for free: idempotent install, clean uninstall, versioning, no clobbering of user hooks, and **no writes outside the sandbox** — which removes the entire Mac App Store constraint that v1 §10 was designed around.

**Fallback — `pet-adapter install`.** For users who do not want a plugin. Requirements unchanged from v1: merge, never overwrite; back up to `settings.json.bak-<ISO8601>`; idempotent; uninstall removes only entries whose `url` matches our endpoint. Identify our entries by URL, not by position.

The port is baked into the URL, so a non-default `PET_PORT` requires regenerating the config. `pet-adapter doctor` prints the correct block for the current port and tells the user which install path is active.

### 5.5 Self-protection

The pet must never become the hung process of I2:
- The `/event/*` handler does zero work before responding: parse-size check, push to an unbounded-but-capped channel (drop-oldest at 1 000), respond `204`.
- A supervisor task asserts the channel drains; if the webview stops consuming for > 5 s, the server keeps 204-ing and drops events rather than backpressuring.
- If the webview crashes, the server stays up and keeps returning 204.

---

## 6. Event schema

### 6.1 Wire format

```ts
// packages/protocol/src/events.ts
export const PET_EVENT_VERSION = 1;

export type ToolKind =
  | "bash" | "file_edit" | "file_read" | "search" | "network" | "delegate" | "other";

export type BlockReason =
  | "rate_limit" | "overloaded" | "billing" | "auth" | "invalid_request" | "unknown";

export interface PetEventMeta {
  readonly v: typeof PET_EVENT_VERSION;
  /** adapter id, e.g. "claude-code" */
  readonly source: string;
  /** stable per agent session; required for multi-session (§8) */
  readonly sessionId: string;
  /** basename of cwd — shown when >1 session is live */
  readonly project?: string;
  /** epoch ms, stamped by the receiver, never by the adapter */
  readonly at: number;
}

export type PetEventBody =
  | { type: "SESSION_START" }
  | { type: "SESSION_END" }
  | { type: "PROMPT_SUBMITTED" }
  | { type: "TOOL_START"; tool: ToolKind; label?: string }
  | { type: "TOOL_DONE"; ok: boolean; tool: ToolKind }
  | { type: "APPROVAL_NEEDED"; tool?: ToolKind; label?: string }
  | { type: "APPROVAL_RESOLVED"; granted: boolean }
  | { type: "AGENT_IDLE" }
  | { type: "TURN_END" }
  | { type: "AGENT_BLOCKED"; reason: BlockReason }
  // reserved, Phase 1.5 — accept and ignore in Phase 1
  | { type: "SUBAGENT_START"; agentType?: string }
  | { type: "SUBAGENT_END" };

export type PetEvent = PetEventMeta & PetEventBody;
```

**`TURN_END`, not `TASK_COMPLETE`.** This is the second substantive correction to v1. `Stop` fires at the end of **every** assistant turn, not when work is finished. A pet that hoists a trophy every twenty seconds trains the user to ignore the trophy. `TURN_END` is a *fact*; whether it deserves a celebration is a *policy* decision, made by the `celebrationWorthy` guard (§7.3) using session context. Adapters report facts; the machine decides meaning.

### 6.2 Events the pet ignores in Phase 1

Unknown `type` values and unknown `v` values are logged to the event log and dropped. Never throw, never crash. Forward compatibility is a protocol requirement.

### 6.3 Claude Code mapping

`mapping.ts` is pure and table-driven:

| Hook event | Payload field consulted | `PetEvent` |
| :-- | :-- | :-- |
| `SessionStart` | — | `SESSION_START` |
| `SessionEnd` | — | `SESSION_END` |
| `UserPromptSubmit` | — | `PROMPT_SUBMITTED` |
| `PreToolUse` | `tool_name` → `tools.ts` | `TOOL_START { tool }` |
| `PostToolUse` | `tool_name`, `is_error` | `TOOL_DONE { ok: !is_error, tool }` |
| `PostToolUseFailure` | `tool_name` | `TOOL_DONE { ok: false, tool }` |
| `PermissionRequest` | `tool_name` | `APPROVAL_NEEDED { tool, label }` |
| `PermissionDenied` | — | `APPROVAL_RESOLVED { granted: false }` |
| `Notification` | `notification_type` | `permission_prompt` → `APPROVAL_NEEDED`; `idle_prompt` / `agent_needs_input` → `AGENT_IDLE`; `agent_completed` → `TURN_END`; anything else → `[]` |
| `Stop` | — | `TURN_END` |
| `StopFailure` | matcher/error type | `AGENT_BLOCKED { reason }`, defaulting to `unknown` |

`tools.ts` classification (the only place tool names appear):

| `ToolKind` | Tool names |
| :-- | :-- |
| `bash` | `Bash`, `BashOutput`, `KillShell` |
| `file_edit` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| `file_read` | `Read`, `Glob`, `Grep` |
| `network` | `WebFetch`, `WebSearch` |
| `delegate` | `Task`, `Agent`, anything matching `^mcp__` |
| `other` | everything else *(default — never throw on an unknown tool)* |

Unknown tool names must fall through to `other`. Claude Code adds tools; the pet must not break when it does.

---

## 7. Behaviour state machine

### 7.1 States

`sleeping` · `idle` · `attentive` · `working{ digging, typing, reading, generic }` · `waiting_approval` · `error` · `exhausted` · `celebrating`

**`exhausted` is new and is the highest-value state in the product.** When the agent is rate-limited, over-quota, or unauthenticated, the terminal shows a retry spinner that looks identical to real work. The pet showing a distinct flat-on-its-back pose is the fastest rate-limit indicator the user has. It is the clearest expression of §1.1.

`error` (a tool failed, work continues) and `exhausted` (the agent is stuck, the user must act) are deliberately separate: one decays after 3 s, the other persists.

### 7.2 Transitions

Root-level (`on:` at machine root — applies from **every** state, satisfying I3):

| Event | Target |
| :-- | :-- |
| `APPROVAL_NEEDED` | `waiting_approval` |
| `AGENT_BLOCKED` | `exhausted` |
| `SESSION_END` | `sleeping` |
| `AGENT_IDLE` | `idle` |
| `PROMPT_SUBMITTED` | `attentive` |
| `TOOL_START` | `working.<byToolKind>` |
| `SESSION_START` | `idle` |

Per-state:

| From | Event / timer | To |
| :-- | :-- | :-- |
| `working.*` | `TOOL_DONE(ok:false)` | `error` |
| `working.*` | `TOOL_DONE(ok:true)` | stay, play a one-shot "hop" overlay |
| `waiting_approval` | `APPROVAL_RESOLVED(granted:true)` \| `TOOL_START` | `working.*` |
| `waiting_approval` | `APPROVAL_RESOLVED(granted:false)` | `idle` |
| any | `TURN_END` **and** `celebrationWorthy` | `celebrating` |
| any | `TURN_END` **and** `!celebrationWorthy` | `idle` |
| `celebrating` | `after 4 s` | `idle` |
| `error` | `after 3 s` | `idle` |
| `exhausted` | `PROMPT_SUBMITTED` \| `TOOL_START` \| `after 10 min` | `idle` |
| `idle` | `after 90 s` | `sleeping` |
| **any non-`sleeping`** | **`after 5 min` with no event (watchdog)** | `idle`, then `sleeping` |

`TOOL_START` mapping: `bash → digging`, `file_edit → typing`, `file_read | search → reading`, everything else → `generic`.

The watchdog is the I4 backstop: even if the per-state timers are wrong, nothing survives five silent minutes.

### 7.3 `celebrationWorthy`

Context tracked per focused session: `toolsThisTurn`, `turnStartedAt`, `hadFailureThisTurn`.

```
celebrationWorthy := toolsThisTurn >= 1
                  && (now - turnStartedAt) >= 15_000
                  && !hadFailureThisTurn
```

Tune the constants; keep the shape. Answering a question is not an achievement. Both counters reset on `PROMPT_SUBMITTED`.

### 7.4 Animation preemption

xstate handles logic; the DOM needs help. A CSS `steps()` animation does **not** restart when the state changes to one using the same `animation-name`. Give the sprite element a `key` derived from `state.value + entryCount` so React remounts it. This one line is the difference between I3 holding and quietly failing.

---

## 8. Multi-session

> The single largest gap in v1. Real users run three to five Claude Code sessions at once. All of them POST to the same port. Without this section the pet thrashes and M2 passes on a single-session demo while failing on a real workday.

### 8.1 Session registry

`sessions/registry.ts` keeps `Map<sessionId, SessionState>`:

```ts
interface SessionState {
  sessionId: string;
  source: string;
  project?: string;
  lastEventAt: number;
  machineState: string;       // that session's own state value
  needsAttention: boolean;    // waiting_approval | exhausted
  attentionSince?: number;
}
```

Every `PetEvent` is routed to its own session's machine actor. Sessions with no event for 10 minutes are evicted (synthesising `SESSION_END`). Eviction is what keeps memory flat over a workday (M2 criterion).

### 8.2 Focus policy

The single visible pet renders **one** focused session, chosen in strict order:

1. The **oldest** session with `needsAttention` (approval or exhausted) — the user is blocking someone; show the one who has waited longest.
2. Otherwise, the session with the most recent event.
3. Otherwise, `sleeping`.

Rule 1 outranks recency deliberately: an unanswered approval is the only state where the pet is asking for something.

### 8.3 Display

- `SessionBadge` shows the live session count when > 1.
- `SpeechBubble` prefixes the project name when > 1 session is live: `acme-api · Approve?`
- *(Phase 1.5)* tray → **Pin to session** locks focus to one project.
- *(Phase 1.5)* one pet per session, arranged along a screen edge.

---

## 9. Window, rendering, tray

### 9.1 Window

**208 × 232** (one 192 × 208 atlas frame at 1× plus room for the glyph and bubble anchors), transparent, `decorations: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`, no shadow. A tray **Size** submenu offers 0.75× / 1× / 1.5×.

Requirements that v1 missed and that must be proven in **M0**, not discovered in M2:

- **macOS full-screen spaces.** A plain always-on-top window does **not** float above full-screen apps. Many developers run their terminal full-screen — i.e. the pet vanishes exactly when it matters. Requires `set_visible_on_all_workspaces(true)` plus an `NSWindowCollectionBehavior` including `fullScreenAuxiliary`. **Spike this on day one; if it cannot be solved, the product thesis changes.**
- **Position persistence** across restarts, with clamping: on launch, if the saved position is not inside any currently connected monitor, snap to the primary monitor's bottom-right.
- **Drag vs click-through.** `data-tauri-drag-region` on the sprite; click-through via `set_ignore_cursor_events(true)`. While click-through is on the pet cannot be dragged — the tray item must be labelled *"Click-through (pet not draggable)"* and there must always be a tray route back. Never leave the user with an unclickable, unmovable pet.
- **`prefers-reduced-motion`** → hold a single frame per state instead of animating.

### 9.2 Sprites

The atlas format is **not ours** — see §12. Summary for rendering:

- **192 × 208 px per frame**, 8 columns × 9 rows (v1, 1536 × 1872) or 8 × 11 (v2, 1536 × 2288). WebP or PNG.
- Row → animation is fixed by the format (§12.1), not declared per pack. `stateMap.ts` maps our states onto those rows.
- Scale with `image-rendering: pixelated` and integer factors only.
- **Placeholder art is expected through M1**: a coloured rectangle plus an emoji per state, rendered into a real atlas of the correct geometry so the pipeline is exercised from day one.
- **I6:** in `sleeping`, set `animation: none` and render one static frame. Not "low fps" — none.

### 9.3 Tray menu

```
Show / Hide pet
Click-through (pet not draggable)      [toggle]
Choose pet ▸        (Phase 1.5 — installed packs; "Get more pets…" opens the gallery)
Size ▸              0.75× · 1× · 1.5×
State glyphs                           [toggle, default on]
Demo ▸              full session · approval · rate limit · error · multi-session
Event log…          (debug window, §11.3)
Copy hook config    (current port, ready to paste)
─────────
Quit
```

### 9.4 Strings

All user-visible strings live in `packs/*/strings.json`, keyed by state. Ship `en` and `vi`. Default pack strings:

| State | EN | VI |
| :-- | :-- | :-- |
| `waiting_approval` | `Approve?` | `Duyệt nhé?` |
| `exhausted` | `Rate limited…` | `Hết lượt rồi…` |
| `error` | `Ouch.` | `Á!` |
| `celebrating` | `Done!` | `Xong!` |

### 9.5 Overlay glyph layer

The pack supplies the **body**; `pet-core` supplies a small **state glyph** composited on top (corner badge + optional glow):

| State | Glyph | Glow |
| :-- | :-- | :-- |
| `waiting_approval` | ❓ | pulsing amber |
| `exhausted` | 🔋 | dim red, static |
| `error` | ⚠️ | red flash, 3 s |
| `celebrating` | 🏆 | none |
| everything else | none | none |

Two reasons this layer exists:

1. **It closes the row deficit.** The atlas has 9 animation rows; we have 10 states. The glyph disambiguates states that must share a row (`error` vs `exhausted`) without asking pack authors for extra art.
2. **It preserves §1.1 across third-party art.** A 4 000-pet gallery has wildly varying legibility. The glyph guarantees that "waiting on you" and "rate-limited" are readable *no matter which pet the user installed*. It is the instrument, drawn over the toy.

**Spike D · F5 upgraded this layer from useful to load-bearing.** Row 7 is documented upstream as a generic run loop; in practice `frog` draws a laptop, `slime` draws a barely perceptible expression change, and `boba` is near-indistinguishable from idle. Body animation alone provably cannot carry state across the gallery. The glyph is the only part of the render that we control on every pet.

The glyph respects `prefers-reduced-motion` (no pulse, static only) and is disableable from the tray.

---

## 10. Security

The threat model is small but not empty, and the mitigations are cheap.

| Control | Rule |
| :-- | :-- |
| Bind | `127.0.0.1` only. Never `0.0.0.0`. |
| Size | Reject bodies > 8 KB with `413`. |
| Content type | Require `application/json`. |
| **Browser lockout** | **Reject any request carrying an `Origin` or `Sec-Fetch-Site` header.** Browsers always send these; hooks never do. One rule, zero config, and it closes the entire "any web page can POST to your loopback port" vector. |
| Token *(optional hardening)* | If `PET_TOKEN` is set, require `X-Pet-Token`. The `http` hook type supports `headers` with `allowedEnvVars`, so this costs one line in `hooks.json`. Promoted from Phase 3 to Phase 1 because it is nearly free. |
| Response | Always `204`, always empty (**I1**). Never echo input. |
| Logging | Payloads may contain file paths and prompt text. Log to stdout in dev only; **never write event payloads to disk** in Phase 1. The event-log window is in-memory, capped at 200 entries. |

---

## 11. Testing & tooling

### 11.1 `pet-adapter record` — fixtures from reality, not memory

A mode that starts a bare HTTP listener, writes every raw hook payload to `test/fixtures/<event>-<n>.json`, and always replies `204`. Run one real Claude Code session through it and the mapping test suite gains real fixtures.

This exists because the hooks schema evolves. Fixtures recorded from a live agent are the only defence against a spec written from memory. **Re-record before every release.**

### 11.2 Demo mode — promoted to M1

v1 filed demo mode under "distribution notes, not Phase 1 work". That was backwards. It is:
- the fastest development loop (exercise all nine states without running an agent),
- the only way to test multi-session deterministically,
- the marketing GIF generator,
- what App Review needs to evaluate the app without Claude Code installed.

Scenarios feed `POST /pet-event` (pre-normalised `PetEvent`, bypassing the adapter) through the otherwise-normal pipeline.

### 11.3 Event log window

A tray-toggled window listing the last 200 events: `time · source · session · type · mapped state`. Non-negotiable for debugging a system whose inputs are invisible. Costs an afternoon; saves a week.

### 11.4 Test matrix

| Area | Tests | Invariant |
| :-- | :-- | :-- |
| `mapping.ts` | Table-driven over recorded fixtures; unknown tool → `other`; unknown event → `[]`; malformed payload → `[]`, never throws | — |
| `petMachine` | Every row of §7.2; preemption from all nine states; every decay timer; watchdog | I3, I4 |
| `celebrationWorthy` | Short Q&A turn → no celebration; long tool-using turn → celebration; failed turn → no celebration | — |
| `sessions/focus` | Approval outranks recency; oldest-attention wins; eviction after 10 min | — |
| `packs/atlas` + `loader` | v1 (1536×1872) and v2 (1536×2288) accepted; 2× scales accepted; wrong geometry rejected with a warning, not a crash; missing `pet.json` skipped; empty row falls back to `idle` | I4 |
| `packs/stateMap` | Every one of the 10 states resolves to a row that exists in the golden fixture pet | — |
| `server` | Always 204; > 8 KB → 413; `Origin` present → 403; malformed JSON → 204 + drop; 1 000-event burst → no backpressure | I1, I2 |
| **latency** | Median tool-call latency with pet running vs. pet killed: **Δ < 5 ms**. With `--hang` debug flag: Δ ≤ 2 s once, and the agent still completes | **I2** |
| `lint:no-agent-strings` | Grep `pet-core/src` excluding `adapters/registry.ts` for `claude`, tool names, hook event names → must be empty | **I5** |
| `install.ts` | Merge preserves unrelated hooks; idempotent across three runs; uninstall restores byte-identical original | — |

### 11.5 CI

GitHub Actions: typecheck, lint (incl. `lint:no-agent-strings`), unit tests, `cargo clippy`, and a build of the macOS + Windows bundles on tags.

---

## 12. Pet packs — adopt the existing format, do not invent one

> **This section replaced a custom `.petpack` format in v2.0.** A de-facto standard already exists, originating in ChatGPT.app's own pet feature and carried by **Petdex** (`petdex.dev`, MIT, ~3.7 k stars, **4 289 pets** in its public manifest as of 2026-08-01). Inventing a rival format would mean solving the art problem from zero while competing with an ecosystem. Adopting it means shipping M3 with thousands of compatible pets and becoming a client of that ecosystem instead of a rival to it. See D10 and §17.

### 12.1 Atlas format (external contract — treat as read-only)

```
<pet>/
├── pet.json            { id, displayName, description, spritesheetPath }
└── spritesheet.webp    (or .png)
```

| Property | v1 | v2 |
| :-- | :-- | :-- |
| Grid | 8 cols × 9 rows | 8 cols × 11 rows |
| Sheet size | 1536 × 1872 | 1536 × 2288 |
| Frame | 192 × 208 | 192 × 208 |

Clean integer scales of either are valid. Accept both; reject anything else with a logged warning (never crash — I4).

**The nine v1 state rows** (from the format's own state viewer):

| State id | Purpose |
| :-- | :-- |
| `idle` | Neutral breathing and blinking loop |
| `running-right` | Directional locomotion, right |
| `running-left` | Directional locomotion, left |
| `waving` | Greeting / attention gesture |
| `jumping` | Anticipation, lift, peak, descent, settle |
| `failed` | Readable error or sad reaction |
| `waiting` | Patient idle variant |
| `running` | Generic in-place run loop |
| `review` | Focused inspecting / thinking loop |

✅ **Resolved by [M0 Spike D](artifacts/spike-d/FINDINGS.md), 2026-08-01.** Five sheets across both versions:

- **Row order is stable** and matches the table above. Safe to hardcode as an enum → `packs/atlas.ts`.
- **Frame counts are per-sheet, not per-format.** Three of four v1 sheets carried `[6,8,8,4,5,8,6,6,6]`, but `cactus` pads every row to 8 by repeating frames and `boba` carries 7 on row 0. **The loader must count live frames per row at load time; a hardcoded table would play padding as animation.** The modal vector is informational only.
- **Rows 1 and 2 are a mirror pair** (near-pixel-perfect on two sheets). A pack missing row 2 can synthesise it by flipping row 1.
- **v2 = v1 rows 0–8 plus two appended rows** of undocumented meaning. Ignore rows 9–10 in Phase 1.
- **Row 7's semantics are author-dependent** — see F5 in the findings, and §9.5.

### 12.2 Loading

- Scan, in order: our own app-data packs dir → `~/.petdex/pets/` → `~/.codex/pets/`. Reading the ecosystem's install roots means `npx petdex install <slug>` already works for our users on day one, with no CLI of our own.
- Validate `pet.json` presence and sheet geometry on load. Invalid packs are skipped with a warning in the event log.
- **The built-in pet is a pack** in exactly this format. One code path from day one — do not build a sprite system and refactor it into packs later.
- **Tauri asset protocol:** a webview cannot load a raw filesystem path. Configure `security.assetProtocol.scope` for each scanned root and use `convertFileSrc()`. This *will* block pack loading if unplanned — budget for it.
- **Never write to `~/.petdex/` or `~/.codex/`.** We read other tools' directories; we do not manage them.

### 12.3 State mapping — 10 states onto 9 rows

`packs/stateMap.ts`, the only place this correspondence exists:

| Our state | Atlas row | fps | Mode | Glyph (§9.5) |
| :-- | :-- | :-- | :-- | :-- |
| `sleeping` | `waiting` | 0 (static frame — **I6**) | hold | — |
| `idle` | `idle` | 1× | loop | — |
| `attentive` | `jumping` → `idle` | 1× | one-shot, then loop | — |
| `working.digging` | `running-right` | 1× | loop | — |
| `working.typing` | `running` | 1× | loop | — |
| `working.reading` | `review` | 1× | loop | — |
| `working.generic` | `running` | 0.8× | loop | — |
| `waiting_approval` | `waving` | 1× | loop | ❓ + amber pulse |
| `error` | `failed` | 1× | one-shot, hold last | ⚠️ + red flash |
| `exhausted` | `failed` | 0.4× | hold last frame | 🔋 + dim red |
| `celebrating` | `jumping` | 1.2× | loop 4 s | 🏆 |

`running-left` is unused in Phase 1; reserved for the Phase 1.5 walk-across-screen idle behaviour, and synthesisable by flipping row 1. Any row missing or empty in a given pack falls back to `idle` — never crash, never freeze.

**Spike D · F6 swapped `typing` and `digging` relative to spec v2.1.** Where authors interpreted row 7 (`running`) at all, they drew *working at a laptop* — `frog` literally types on one — which is our `typing`, not our `bash`. Row 1 is a genuine motion cycle on every sheet and reads as effort, so `digging` takes it.

### 12.4 Gallery integration (M3, opt-in)

`petdex.dev/api/manifest` returns every approved pet with `slug`, `displayName`, `kind`, `spritesheetUrl`, `petJsonUrl`, `zipUrl`. Tray → **Choose pet ▸ Get more pets…** opens the gallery in the browser.

Constraints:
- The manifest fetch is **opt-in and lazy** — never on launch, never without the user opening the picker. The app must be fully functional offline.
- **We never re-host, bundle, or mirror third-party pet assets.** Downloads go from the user's machine to the gallery's CDN. See §17.2 for why this is not negotiable.
- Cache the manifest for 24 h in app-data. Handle non-200 and offline silently.

### 12.5 Authoring

No in-app editor. Packs are authored in Aseprite/Piskel or generated by the ecosystem's own creator tools. `docs/PET_PACKS.md` documents our state mapping and the glyph layer so authors know which rows we actually exercise.

---

## 13. Closed decisions

Do not reopen these while implementing.

| # | Decision | Rationale |
| :-- | :-- | :-- |
| D1 | Mapping runs **in the pet's own process** (adapter registry in the frontend), not in a hook-side script | A hook-side mapper means spawning a process per tool call. That is a direct I2 violation. |
| D2 | I5 is reworded from "zero Claude strings" to "**one** designated file may name an adapter" | The v1 wording is unachievable once mapping runs in-process, and led v1 into a contradiction where nobody performed the mapping. |
| D3 | Broad `.*` matchers + classification in code | Testability; avoids double-firing hooks; keeps all agent knowledge in one package. |
| D4 | Plugin distribution is primary; `settings.json` patching is a fallback | Removes install/uninstall/backup complexity and the MAS sandbox constraint entirely. |
| D5 | `Stop` maps to `TURN_END`, and celebration is gated by a guard | `Stop` fires per turn. Ungated celebration destroys the trophy's signal value. |
| D6 | `waiting_approval` does **not** move the window to screen centre by default | Multi-monitor ambiguity, occludes the content the user is reading, and duplicates the OS notification. Replaced by in-place bounce + glow + badge. Available as an opt-in setting. |
| D7 | `exhausted` is a first-class state, in Phase 1 | Best signal-to-effort ratio in the product (§7.1). |
| D8 | xstate is kept despite being heavy for nine states | Declarative `after` timers make I4 verifiable, and transitions are cheap to test without Tauri. |
| D9 | Auto-port-fallback on a busy port is **rejected** | Hooks hardcode the port in a URL. Silently moving ports means silent breakage. Fail loudly instead. |
| D10 | **Adopt the existing Petdex/Codex atlas format; do not invent `.petpack`** | 4 289 compatible pets exist today and the format is already shared by ChatGPT.app, Petdex and ~21 downstream projects. A rival format would mean solving art from zero against an incumbent. Cost: 9 fixed rows instead of our 10 named states — paid for by the glyph layer (§9.5). |
| D11 | **Only original, licence-cleared art ships in the bundle.** Third-party pets are user-installed at runtime, never re-hosted by us | The public galleries are explicitly user-submitted fan art with disclaimed IP. That is survivable for a free gallery and fatal for a paid, notarised, App-Store-bound product. See §17.2. |
| D12 | Our differentiator is **instrument fidelity**, not the existence of a pet | Free MIT competitors already ship a floating pet with thousands of skins. What they do not have: 11 hook events, `exhausted`, multi-session focus, and I1/I2 as tested guarantees. §17.3. |

---

## 14. Milestones

### M0 — De-risk (2–3 days) ⭐ new

Two unknowns can invalidate the design. Prove them before building anything.

- [ ] **Spike A:** a transparent, always-on-top Tauri 2 window that stays visible above a **full-screen** macOS app, and on Windows above a maximised terminal. Screenshot as evidence.
- [ ] **Spike B:** run `pet-adapter record` against a real Claude Code session; commit fixtures for all eleven hook events in §5.3. Confirm field names, `notification_type` values, and `StopFailure` error types.
- [ ] **Spike C:** measure idle CPU/GPU of an animating transparent always-on-top window over 10 minutes on battery. If it is not ≈ 0 % when static, redesign the render loop now.
- [ ] **Spike D (atlas):** `npx petdex install <slug>`, then render the sheet cell-by-cell and **empirically derive** row order and per-row frame counts for both v1 (8×9) and v2 (8×11). Commit the result as `packs/atlas.ts` with the sample pet as a test fixture. Confirm the app-data roots (`~/.petdex/pets/`, `~/.codex/pets/`) exist as documented. Do not hardcode §12.1's table from this spec.

**Gate:** if Spike A fails on macOS, stop and revisit the product thesis before writing further code. If Spike D shows the atlas cannot express our ten states even with the glyph layer, reopen D10.

### M1 — Skeleton (end of week 1)

- [ ] `pnpm tauri dev` shows a transparent, draggable placeholder pet.
- [ ] `curl -X POST 127.0.0.1:48200/pet-event -H 'Content-Type: application/json' -d '{"v":1,"source":"demo","sessionId":"a","at":0,"type":"TOOL_START","tool":"bash"}'` visibly changes the animation.
- [ ] `GET /health` → `{ ok, version, port, uptime, adapters, sessions }`.
- [ ] All nine states reachable from **Demo ▸**.
- [ ] Event log window works.
- [ ] Tray: Show/Hide, Click-through, Demo, Event log, Copy hook config, Quit.
- [ ] Default pet loads **through the pack loader**, in the real atlas format (§12.1).
- [ ] At least one **third-party pet installed via `npx petdex install`** renders correctly through `stateMap.ts`.
- [ ] State glyph layer renders over any pack (§9.5).
- [ ] Single-instance guard; a busy port fails with an actionable message (D9).

### M2 — Live with Claude Code (end of week 2)

- [ ] `/plugin` install drives the pet end-to-end; `pet-adapter install` fallback merges into `settings.json` with backup, and `uninstall` restores it byte-identically.
- [ ] A real session drives: wake → attentive → digging/typing/reading → waiting_approval → celebrating → sleeping, with no manual input.
- [ ] `exhausted` verified against a real rate-limit (or a `StopFailure` fixture replay).
- [ ] **Two concurrent sessions in different projects:** no state thrash; the approval-blocked session wins focus; the project name appears in the bubble.
- [ ] **I1 verified:** every hook response is `204` with an empty body; a full agent task runs identically with the pet on and off.
- [ ] **I2 verified:** median tool-call latency delta < 5 ms; `kill -9` on the pet mid-session leaves the agent unaffected; a hung pet costs ≤ 2 s once.
- [ ] **I4 verified:** kill a session without `SessionEnd` → the pet decays to `sleeping` within the watchdog window.
- [ ] **I6 verified:** ≈ 0 % CPU while `sleeping`.
- [ ] **Workday soak:** 8 hours, ≥ 20 sessions, memory flat (session eviction proven), no stuck states.

### M3 — Packs, art & release (week 3–4, only after M2 is green)

- [ ] Scan all three pack roots; tray pack switcher; per-row fallback; geometry validation; v1 + v2 atlases.
- [ ] Lazy, opt-in gallery manifest client; app fully functional offline (§12.4).
- [ ] **Commissioned original default pet** delivered and integrated (§17.2) — this is the release blocker, not the code.
- [ ] `docs/PET_PACKS.md` (our state mapping + glyph layer) and `docs/IP_POLICY.md`.
- [ ] Signed/notarised `.dmg` and a Windows installer.

---

## 15. Out of scope

**Phase 1:** pet levelling/growth · multiplayer/sync · LLM-generated dialogue · git adapter · settings UI beyond the tray · auto-update · remote agents (SSH / devcontainer / web Claude Code cannot reach a local pet — Phase 3's protocol is the answer, and this limitation must be stated in the README).

**Phase 1.5:** in-app pack editor · running our own pet gallery or CDN (D10/D11 — the ecosystem already has one; we are a client) · any CLI of our own for installing pets.

---

## 16. Distribution (context, not implementation work)

- Direct download: notarised `.dmg` + Windows installer. Payments through a merchant of record (Paddle / Lemon Squeezy).
- Mac App Store is viable **because** of D4: with plugin distribution the app writes nothing outside its sandbox. If the `settings.json` fallback ever ships to MAS it must become a user-driven file-picker flow — and it is already isolated in `adapter-claude-code/install.ts` so that nothing else in the app assumes free filesystem access.
- Demo mode (§11.2) makes the app fully demonstrable without Claude Code installed — required for App Review, useful for the landing page.
- **On the moat:** see §17. The short version: the pack ecosystem is *already built by someone else*, so it is no longer available as a moat. What remains is instrument fidelity (D12) and, later, the Pet Protocol.

---

## 17. Competitive landscape & IP policy

*Surveyed 2026-08-01. Re-survey before any pricing decision — this space is moving fast.*

### 17.1 Who is already here

| Project | Signal | What it ships |
| :-- | :-- | :-- |
| **[Petdex](https://github.com/crafter-station/petdex)** (`petdex.dev`) | **~3.7 k ⭐**, MIT, actively pushed | Gallery + npm CLI + desktop floater (Zig/WebKit) with a *"Node HTTP sidecar for agent hooks"*. Codex, Claude Code, Cursor, Gemini CLI. **4 289 pets** in the public manifest. ~21 downstream projects |
| **ChatGPT.app** | first-party | Ships the pet atlas format itself, plus a gated `codex://pets/install` deep link |
| [agentpets.dev](https://agentpets.dev) | 0 ⭐, MIT, new | Gallery clone, little traction |
| codex-pets/codex-pets | repo now 404 | Gone |

**Read this honestly:** Phase 1 as originally specified is *behind* a free MIT product that already floats a pet over every window, hooks into Claude Code, and offers thousands of skins. "We built a desktop pet for your coding agent" is no longer a product claim.

### 17.2 IP policy — binding

The galleries state their position plainly: *"Pets are user-submitted fan art. AgentPets does not claim rights to any underlying IP"* / *"pet assets remain owned by their submitters and original rights holders."* A keyword scan of the 4 289-pet manifest surfaces **Homelander, Goku, Pikachu, Doraemon, Totoro, Naruto, Kirby, Gojo, Pochita, Hello Kitty, Sonic** within the first pass alone — and 2 132 of those pets are typed `character`, so the real figure is far higher.

That posture is survivable for a free gallery with a takedown form. It is fatal for a paid, notarised, App-Store-bound product. Therefore:

1. **Nothing ships in our bundle without a licence we hold.** The default pet is commissioned original art with a written **work-for-hire / full commercial + redistribution** grant, or a CC0 asset (Kenney.nl and CC0-filtered OpenGameArt are acceptable stopgaps through M2).
2. **We never re-host, mirror, cache-to-CDN, or redistribute third-party pets.** The user installs them; the bytes travel from the gallery's CDN to their disk. We are a renderer, not a distributor.
3. **No character names, no fan art, in any marketing asset, screenshot, landing page, or App Store listing.** Every promotional frame uses our own pet.
4. `docs/IP_POLICY.md` states 1–3 publicly, so users understand exactly what they are installing and from whom.

### 17.3 Where the gap actually is

The incumbents compete on *quantity of pets*. That contest is over. The gap they leave is **fidelity** — §1.1's 200 ms glance test, taken seriously:

| | Typical incumbent | Us |
| :-- | :-- | :-- |
| Agent signals | tool calls, roughly | **11 hook events**, incl. `PermissionRequest`, `PostToolUseFailure`, `StopFailure` |
| Rate limit / quota | indistinguishable from working | **`exhausted`** — a dedicated state (§7.1) |
| Several sessions at once | unhandled | **Focus policy** — the blocked session wins (§8.2) |
| Effect on the agent | untested | **I1 + I2 as tested guarantees** (§11.4) |
| Reliability | unclear | **I4 watchdog** — no wedged pet, ever |

Positioning follows: not *"a desktop pet for your agent"* but **"the most accurate agent instrument, that happens to be cute."** Target the developer running four sessions across three projects — the user for whom a toy pet actively fails. Adopting the incumbent format (D10) means that user keeps every pet they already own; only the instrument changes.

**Kill criterion, stated in advance.** If M2 ships and the fidelity gap above turns out to be reproducible by an incumbent in a weekend, the honest move is to contribute a Tauri client upstream rather than ship the fifth pet app into a market with a free leader. Decide this with M2 in hand, not before.
