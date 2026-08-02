import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/mapping.ts";
import { classifyTool } from "../src/tools.ts";

const CTX = { receivedAt: 1_700_000_000_000 };
const BASE = { session_id: "s1", cwd: "/Users/x/Project/acme-api" };

const map = (raw: unknown) => claudeCodeAdapter.toPetEvents(raw, CTX);
const one = (raw: unknown) => {
  const out = map(raw);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe("classifyTool", () => {
  it.each([
    ["Bash", "bash"],
    ["BashOutput", "bash"],
    ["Edit", "file_edit"],
    ["NotebookEdit", "file_edit"],
    ["Grep", "file_read"],
    ["WebFetch", "network"],
    ["Task", "delegate"],
    ["mcp__linear__save_issue", "delegate"],
  ] as const)("%s -> %s", (name, kind) => {
    expect(classifyTool(name)).toBe(kind);
  });

  it("falls through to other for unknown and malformed names", () => {
    // Agents add tools constantly; an unknown tool must never break the pet.
    expect(classifyTool("SomeToolShippedNextWeek")).toBe("other");
    expect(classifyTool(undefined)).toBe("other");
    expect(classifyTool(42)).toBe("other");
    expect(classifyTool("")).toBe("other");
  });
});

describe("mapping — envelope", () => {
  it("stamps version, source, session and project basename", () => {
    const e = one({ ...BASE, hook_event_name: "SessionStart" });
    expect(e).toMatchObject({
      v: 1,
      source: "claude-code",
      sessionId: "s1",
      project: "acme-api",
      at: CTX.receivedAt,
      type: "SESSION_START",
    });
  });

  it("handles Windows-style cwd", () => {
    const e = one({ ...BASE, cwd: "C:\\work\\acme-api", hook_event_name: "Stop" });
    expect(e.project).toBe("acme-api");
  });

  it("omits project when cwd is absent", () => {
    const e = one({ session_id: "s1", hook_event_name: "Stop" });
    expect(e).not.toHaveProperty("project");
  });

  it("drops events with no session id — the focus policy needs one", () => {
    expect(map({ hook_event_name: "Stop" })).toEqual([]);
    expect(map({ ...BASE, session_id: "", hook_event_name: "Stop" })).toEqual([]);
  });
});

describe("mapping — hook events", () => {
  it.each([
    ["SessionStart", "SESSION_START"],
    ["SessionEnd", "SESSION_END"],
    ["UserPromptSubmit", "PROMPT_SUBMITTED"],
    ["Stop", "TURN_END"],
    ["PermissionDenied", "APPROVAL_RESOLVED"],
  ] as const)("%s -> %s", (hook, type) => {
    expect(one({ ...BASE, hook_event_name: hook }).type).toBe(type);
  });

  it("PreToolUse carries the classified tool", () => {
    expect(one({ ...BASE, hook_event_name: "PreToolUse", tool_name: "Bash" })).toMatchObject({
      type: "TOOL_START",
      tool: "bash",
    });
  });

  it("PostToolUse reads is_error", () => {
    const ok = one({ ...BASE, hook_event_name: "PostToolUse", tool_name: "Edit" });
    expect(ok).toMatchObject({ type: "TOOL_DONE", ok: true, tool: "file_edit" });

    const bad = one({
      ...BASE,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      is_error: true,
    });
    expect(bad).toMatchObject({ type: "TOOL_DONE", ok: false });
  });

  it("PostToolUseFailure is always a failure", () => {
    expect(
      one({ ...BASE, hook_event_name: "PostToolUseFailure", tool_name: "Bash" }),
    ).toMatchObject({ type: "TOOL_DONE", ok: false, tool: "bash" });
  });

  it("PermissionRequest is not an approval prompt", () => {
    // It fires on every permission *evaluation*, auto-approved ones included.
    // Treating it as a prompt made the pet ask "May I?" for every bash command
    // and, because it arrives after PreToolUse, parked it there — an entire
    // observed session reached only three states: asleep, digging, asking.
    expect(
      claudeCodeAdapter.toPetEvents(
        { ...BASE, hook_event_name: "PermissionRequest", tool_name: "Bash" },
        { receivedAt: 1 },
      ),
    ).toEqual([]);
  });

  it("a real prompt still reaches the pet", () => {
    // The signal that means a human is actually being asked, and the one that
    // was right all along.
    expect(
      one({ ...BASE, hook_event_name: "Notification", notification_type: "permission_prompt" }),
    ).toMatchObject({ type: "APPROVAL_NEEDED" });
  });
});

describe("mapping — Notification switches on notification_type", () => {
  it.each([
    ["permission_prompt", "APPROVAL_NEEDED"],
    ["idle_prompt", "AGENT_IDLE"],
    ["agent_needs_input", "INPUT_NEEDED"],
    ["agent_completed", "TURN_END"],
  ] as const)("%s -> %s", (kind, type) => {
    expect(one({ ...BASE, hook_event_name: "Notification", notification_type: kind }).type).toBe(
      type,
    );
  });

  it("ignores notification types that are not ours", () => {
    for (const kind of ["auth_success", "elicitation_dialog", "something_new"]) {
      expect(map({ ...BASE, hook_event_name: "Notification", notification_type: kind })).toEqual(
        [],
      );
    }
  });
});

describe("mapping — StopFailure feeds the exhausted state", () => {
  it.each([
    ["rate_limit", "rate_limit"],
    ["overloaded", "overloaded"],
    ["billing_error", "billing"],
    ["authentication_failed", "auth"],
    ["invalid_request", "invalid_request"],
  ] as const)("%s -> %s", (errorType, reason) => {
    expect(one({ ...BASE, hook_event_name: "StopFailure", error_type: errorType })).toMatchObject({
      type: "AGENT_BLOCKED",
      reason,
    });
  });

  it("defaults unrecognised error types to unknown", () => {
    expect(one({ ...BASE, hook_event_name: "StopFailure", error_type: "brand_new" })).toMatchObject(
      { type: "AGENT_BLOCKED", reason: "unknown" },
    );
    expect(one({ ...BASE, hook_event_name: "StopFailure" })).toMatchObject({ reason: "unknown" });
  });
});

describe("mapping — never throws", () => {
  it.each([null, undefined, 42, "string", [], {}, { hook_event_name: "Unknown" }])(
    "returns [] for %o",
    (input) => {
      expect(() => map(input)).not.toThrow();
      expect(map(input)).toEqual([]);
    },
  );

  it("tolerates unknown extra fields", () => {
    const e = one({ ...BASE, hook_event_name: "Stop", future_field: { a: 1 }, effort: "high" });
    expect(e.type).toBe("TURN_END");
  });
});

describe("hooks M5 added, and what they are for", () => {
  const at = 1_000;
  const map = (raw: Record<string, unknown>) =>
    claudeCodeAdapter.toPetEvents({ session_id: "s", cwd: "/w/p", ...raw }, { receivedAt: at });

  it("brackets compaction at both ends", () => {
    // Only PreCompact was registered at first, so the state unwound on a
    // five-minute decay — a guess wearing the clothes of a fact.
    expect(map({ hook_event_name: "PreCompact" })[0]).toMatchObject({ type: "COMPACTING" });
    expect(map({ hook_event_name: "PostCompact" })[0]).toMatchObject({ type: "COMPACTED" });
  });

  it("brackets a subagent at both ends, and keeps its type", () => {
    // SUBAGENT_START sat unused in the wire format from M0 until the review
    // established that SubagentStart is a real hook — the pet had been
    // inferring delegation from a tool name instead of being told.
    expect(map({ hook_event_name: "SubagentStart", agent_type: "Explore" })[0]).toMatchObject({
      type: "SUBAGENT_START",
      agentType: "Explore",
    });
    expect(map({ hook_event_name: "SubagentStop" })[0]).toMatchObject({ type: "SUBAGENT_END" });
  });

  it("omits the agent type rather than inventing one", () => {
    expect(map({ hook_event_name: "SubagentStart" })[0]).not.toHaveProperty("agentType");
    expect(map({ hook_event_name: "SubagentStart", agent_type: 7 })[0]).not.toHaveProperty(
      "agentType",
    );
  });

  it("treats an MCP server asking a question as a claim on the user", () => {
    expect(map({ hook_event_name: "Elicitation" })[0]).toMatchObject({ type: "INPUT_NEEDED" });
    expect(map({ hook_event_name: "ElicitationResult" })[0]).toMatchObject({ type: "AGENT_IDLE" });
  });
});

describe("what the pet says the agent is doing", () => {
  const label = (toolName: string, toolInput: unknown) => {
    const [e] = claudeCodeAdapter.toPetEvents(
      { ...BASE, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput },
      { receivedAt: 1 },
    );
    return (e as { label?: string } | undefined)?.label;
  };

  it("names the command, not the agent's prose about it", () => {
    // "Running list the docs directory" was the first attempt. The verb already
    // says it is running something; what a reader needs is *what*.
    expect(label("Bash", { command: "ls docs/", description: "List the docs directory" })).toBe(
      "ls docs/",
    );
  });

  it.each([
    ["cd ~/p && pnpm verify", "pnpm verify"],
    ["export A=1; cargo test --all", "cargo test"],
    ["grep -rn TODO src/", "grep TODO src/"],
    ["git status", "git status"],
  ])("strips the plumbing off %s", (command, want) => {
    // The last segment does the work, and flags are dropped from it. Reducing
    // to the program name turned `grep -rn TODO src/` into "grep", which
    // answers nothing — the pattern is the entire point of a grep — but the
    // flags spend a narrow bubble's width saying nothing either.
    expect(label("Bash", { command })).toBe(want);
  });

  it("names the file, not the path", () => {
    expect(label("Read", { file_path: "/a/b/PET_PACKS.md" })).toBe("PET_PACKS.md");
    expect(label("Edit", { file_path: "/x/y/mapping.ts" })).toBe("mapping.ts");
  });

  it("names the pattern, the host, and the agent type", () => {
    expect(label("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(label("WebFetch", { url: "https://petdex.dev/api/manifest" })).toBe("petdex.dev");
    expect(label("Task", { subagent_type: "Explore" })).toBe("Explore");
  });

  it("truncates rather than letting the bubble grow without bound", () => {
    const long = label("Grep", { pattern: "x".repeat(200) }) ?? "";
    expect(long.length).toBeLessThanOrEqual(52);
    expect(long.endsWith("…")).toBe(true);
  });

  it("omits the label rather than inventing one", () => {
    expect(label("Bash", {})).toBeUndefined();
    expect(label("Read", {})).toBeUndefined();
  });
});
