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

  it("PermissionRequest carries the tool being approved", () => {
    expect(one({ ...BASE, hook_event_name: "PermissionRequest", tool_name: "Bash" })).toMatchObject(
      { type: "APPROVAL_NEEDED", tool: "bash" },
    );
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
