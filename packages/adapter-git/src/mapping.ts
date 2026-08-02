import {
  type AdapterContext,
  PET_EVENT_VERSION,
  type PetAdapter,
  type PetEvent,
  type PetEventBody,
} from "@agent-pet/protocol";

/**
 * Git, as a second agent.
 *
 * Spec §1.2 Phase 2. Its real job is to test a claim made at M0 and never
 * checked since: that the architecture is adapter-based *so that* a second
 * agent is an addition rather than a rewrite.
 *
 * Git fits the push model exactly. Its hooks are local scripts that run at
 * known moments, which is the same shape as the agent's — no polling, no
 * watcher, nothing ticking while the pet is asleep (I6). What it does not have
 * is a session: a repository is the only stable identity on offer, so the
 * repository is what a "session" means here.
 *
 * The payload shape is ours, because we write the hook script that sends it.
 * That is the one luxury this adapter has over the other, where every field is
 * whatever upstream decided that week.
 */

export const ADAPTER_ID = "git";

interface RawGit {
  event?: unknown;
  repo?: unknown;
  branch?: unknown;
  /** Files touched, when the hook can cheaply know. */
  files?: unknown;
  /** Where a push is going. */
  remote?: unknown;
}

function basename(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  return path.split("/").filter(Boolean).at(-1);
}

function text(value: unknown, max = 32): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Pure. No I/O, no clock, no randomness — see PetAdapter's contract. */
function bodiesFor(raw: RawGit): PetEventBody[] {
  const branch = text(raw.branch, 24);

  switch (raw.event) {
    /**
     * A commit is the unit of work here, so it brackets like one: the pre hook
     * starts it and the post hook ends it.
     *
     * `TURN_END` rather than anything more triumphant, for the same reason D5
     * gave: whether it deserves a trophy is the machine's decision, not the
     * adapter's.
     */
    case "pre-commit":
      return [{ type: "TOOL_START", tool: "file_edit", ...(branch ? { label: branch } : {}) }];
    case "post-commit":
      return [{ type: "TURN_END" }];

    case "pre-push":
      return [
        {
          type: "TOOL_START",
          tool: "network",
          ...(text(raw.remote, 24) ? { label: text(raw.remote, 24) as string } : {}),
        },
      ];

    // Merges and rebases rewrite the working tree under you, which is the one
    // moment a git user genuinely wants to know something is happening.
    case "post-merge":
      return [{ type: "TOOL_DONE", ok: true, tool: "file_edit" }];
    case "post-rewrite":
      return [{ type: "TOOL_START", tool: "file_edit", label: "rebase" }];

    case "post-checkout":
      return [{ type: "TOOL_DONE", ok: true, tool: "file_read" }];

    default:
      // Unknown hooks are ordinary. Git grows them and the pet must not break.
      return [];
  }
}

/** The hooks worth installing, and what each one tells the pet. */
export const GIT_HOOKS = [
  "pre-commit",
  "post-commit",
  "pre-push",
  "post-merge",
  "post-rewrite",
  "post-checkout",
] as const;

export const gitAdapter: PetAdapter = {
  id: ADAPTER_ID,
  label: "Git",

  hookConfig(endpoint: string): string {
    // Not JSON, and not something anyone can paste into a settings file. Git
    // hooks are executable scripts, one file per hook, inside a repository.
    return [
      "# Run inside a git repository:",
      "for h in " + GIT_HOOKS.join(" ") + "; do",
      "  printf '#!/bin/sh\\ncurl -sm2 -XPOST -H \"content-type: application/json\" \\\\\\n'" +
        " > .git/hooks/$h",
      `  printf '    -d "{\\"event\\":\\"%s\\",\\"repo\\":\\"$(git rev-parse --show-toplevel)\\",\\"branch\\":\\"$(git branch --show-current)\\"}" \\\\\\n' "$h" >> .git/hooks/$h`,
      `  printf '    ${endpoint} >/dev/null 2>&1 &\\n' >> .git/hooks/$h`,
      "  chmod +x .git/hooks/$h",
      "done",
    ].join("\n");
  },

  toPetEvents(rawInput: unknown, ctx: AdapterContext): PetEvent[] {
    if (typeof rawInput !== "object" || rawInput === null) return [];
    const raw = rawInput as RawGit;

    // The repository *is* the session. There is nothing else stable: hooks are
    // separate processes with no shared identity, and two commits an hour apart
    // in the same checkout are the same piece of work as far as a pet is
    // concerned.
    const repo = typeof raw.repo === "string" ? raw.repo : "";
    if (!repo) return [];

    const meta = {
      v: PET_EVENT_VERSION,
      source: ADAPTER_ID,
      sessionId: repo,
      at: ctx.receivedAt,
      ...(basename(repo) ? { project: basename(repo) as string } : {}),
    } as const;

    return bodiesFor(raw).map((body) => ({ ...meta, ...body }));
  },
};
