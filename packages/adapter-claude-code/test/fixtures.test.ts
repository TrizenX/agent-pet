import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/mapping.ts";

/**
 * The mapping tested against payloads recorded from a live agent, not against
 * objects written from the documentation.
 *
 * `mapping.test.ts` proves the mapping does what we intended. This file proves
 * the intention still matches reality — it is the only thing that fails when
 * the hook schema moves under us. Re-record with `pet-adapter record --install`
 * before every release (spec §11.1).
 *
 * Fixtures are redacted at capture time: keys are preserved, free-text values
 * are replaced. They are committed to a public repo, and raw payloads carry
 * absolute paths, prompt text and tool inputs.
 */

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const CTX = { receivedAt: 1_700_000_000_000 };

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

/** hook_event_name -> the PetEvent type it must produce, or [] for ignored. */
const EXPECTED: Record<string, string | null> = {
  SessionStart: "SESSION_START",
  SessionEnd: "SESSION_END",
  UserPromptSubmit: "PROMPT_SUBMITTED",
  PreToolUse: "TOOL_START",
  PostToolUse: "TOOL_DONE",
  PostToolUseFailure: "TOOL_DONE",
  PermissionRequest: null,
  PermissionDenied: "APPROVAL_RESOLVED",
  Stop: "TURN_END",
  StopFailure: "AGENT_BLOCKED",
  PreCompact: "COMPACTING",
  PostCompact: "COMPACTED",
  SubagentStart: "SUBAGENT_START",
  SubagentStop: "SUBAGENT_END",
  Elicitation: "INPUT_NEEDED",
  ElicitationResult: "AGENT_IDLE",
};

/** Fields `mapping.ts` reads. If one disappears upstream, this is where we find out. */
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  PreToolUse: ["session_id", "hook_event_name", "tool_name"],
  PostToolUse: ["session_id", "hook_event_name", "tool_name"],
  PostToolUseFailure: ["session_id", "hook_event_name", "tool_name"],
  PermissionRequest: ["session_id", "hook_event_name", "tool_name"],
  Notification: ["session_id", "hook_event_name", "notification_type"],
  Stop: ["session_id", "hook_event_name"],
  StopFailure: ["session_id", "hook_event_name"],
  // `agent_type` is what makes SubagentStart worth having over guessing a
  // delegation from a tool name. If it ever disappears, this is where we find
  // out rather than in a pet that stopped distinguishing delegated work.
  SubagentStart: ["session_id", "hook_event_name", "agent_type"],
  SubagentStop: ["session_id", "hook_event_name"],
  PreCompact: ["session_id", "hook_event_name"],
  PostCompact: ["session_id", "hook_event_name"],
};

describe("recorded fixtures", () => {
  it("exist — a spike that recorded nothing proves nothing", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s maps to the expected event", (file) => {
    const raw = load(file);
    const events = claudeCodeAdapter.toPetEvents(raw, CTX);
    const hook = raw.hook_event_name as string;

    if (hook === "Notification") {
      // Only some notification types are ours; the rest must be dropped.
      const want = {
        permission_prompt: "APPROVAL_NEEDED",
        idle_prompt: "AGENT_IDLE",
        agent_needs_input: "INPUT_NEEDED",
        agent_completed: "TURN_END",
      }[raw.notification_type as string];
      if (want) {
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe(want);
      } else {
        expect(events).toEqual([]);
      }
      return;
    }

    const want = EXPECTED[hook];
    expect(want, `${hook} is not in the expected-event table`).not.toBeUndefined();
    if (want === null) {
      // Registered so the shape stays pinned, but deliberately not a state.
      expect(events).toEqual([]);
      return;
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(want);
  });

  it.each(files)("%s carries every field the mapping reads", (file) => {
    const raw = load(file);
    for (const field of REQUIRED_FIELDS[raw.hook_event_name as string] ?? []) {
      expect(raw, `${file} is missing ${field}`).toHaveProperty(field);
    }
  });

  it.each(files)("%s produces a well-formed envelope", (file) => {
    for (const e of claudeCodeAdapter.toPetEvents(load(file), CTX)) {
      expect(e.v).toBe(1);
      expect(e.source).toBe("claude-code");
      expect(e.sessionId).toBeTruthy();
      expect(e.at).toBe(CTX.receivedAt);
    }
  });

  it("contains no unredacted absolute paths from the recording machine", () => {
    // Guard against someone re-recording with --no-redact and committing it.
    for (const file of files) {
      const text = readFileSync(join(DIR, file), "utf8");
      expect(text, file).not.toMatch(/\/Users\/(?!user\b)/);
      expect(text, file).not.toMatch(/\/home\/(?!user\b)/);
    }
  });
});

describe("schema drift — findings from the recording", () => {
  const postToolUse = files.filter((f) => f.startsWith("PostToolUse-")).map(load);

  it("PostToolUse does NOT carry is_error, despite the docs listing it", () => {
    // Documented but never observed. The mapping still handles it defensively,
    // and this test exists so that we notice if it ever starts appearing.
    for (const raw of postToolUse) expect(raw).not.toHaveProperty("is_error");
  });

  it("failures arrive as PostToolUseFailure, which is why we register for it", () => {
    // If we had relied on PostToolUse.is_error alone (the documented route),
    // the error state would never fire. This is the evidence for that choice.
    const failures = files.filter((f) => f.startsWith("PostToolUseFailure-"));
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) {
      const raw = load(f);
      expect(raw).toHaveProperty("error");
      expect(claudeCodeAdapter.toPetEvents(raw, CTX)[0]).toMatchObject({
        type: "TOOL_DONE",
        ok: false,
      });
    }
  });

  it("PermissionRequest carries tool_name, so the bubble can name the tool", () => {
    for (const f of files.filter((x) => x.startsWith("PermissionRequest-"))) {
      expect(load(f)).toHaveProperty("tool_name");
    }
  });

  /**
   * The reason `exhausted` cannot say why.
   *
   * `BLOCK_REASONS` maps eight upstream strings — rate_limit, overloaded,
   * billing_error, authentication_failed … — onto the reason the pet reports,
   * and the mapping looks them up under `raw.error_type`. The first real
   * `StopFailure` ever recorded does not carry `error_type`. It carries
   * `error`, free text.
   *
   * So every genuine block resolves to "unknown" and the whole table is
   * unreachable. Written from documentation, exercised only by payloads we
   * wrote ourselves, and wrong since M0 — for the state §7.1 calls the
   * highest-value in the product.
   *
   * Pinned rather than fixed: what `error` actually contains is still being
   * captured, and guessing a parse from one redacted sample is how the
   * `error_type` table got here in the first place.
   */
  it("StopFailure has no error_type, so BLOCK_REASONS never matches", () => {
    const stops = files.filter((f) => f.startsWith("StopFailure-")).map(load);
    expect(stops.length).toBeGreaterThan(0);
    for (const raw of stops) {
      expect(raw, "if error_type ever appears, BLOCK_REASONS can be revived").not.toHaveProperty(
        "error_type",
      );
      expect(raw).toHaveProperty("error");
      expect(claudeCodeAdapter.toPetEvents(raw, CTX)[0]).toMatchObject({
        type: "AGENT_BLOCKED",
        reason: "unknown",
      });
    }
  });
});

/**
 * Which hooks have no recorded evidence at all.
 *
 * Every test above iterates over the fixtures that exist, so a hook with no
 * fixture is not tested — it is *invisible*. The suite has been green this
 * whole time while five of the sixteen hooks in `EXPECTED` had never been seen
 * coming out of a real agent. Their mappings are written from documentation
 * and checked against payloads we composed ourselves, which is the situation
 * §11.1 says recording exists to end.
 *
 * A test that simply demanded a fixture for every hook would be red today and
 * would be deleted by the third person who hit it. So the gap is written down
 * instead, with the reason each one is missing. That makes two things fail
 * that used to pass silently: adding a hook to the mapping without either a
 * fixture or an explicit admission, and — the one that matters — *recording a
 * fixture and forgetting to take it off this list*.
 */
describe("hooks with no recorded fixture", () => {
  const recorded = new Set(files.map((f) => f.replace(/-\d+\.json$/, "")));

  /**
   * hook -> why it has never been captured. Delete the entry with the fixture.
   *
   * These used to read "needs a human at a keyboard". Fifteen real interactive
   * sessions later — driven under a pty, which is a real session by every
   * measure the tool applies — three of them are better described as *not
   * emitted by Claude Code 2.1.220*. Keeping the old wording would have left
   * the list looking like a to-do when it is really a finding.
   */
  const UNCAPTURED: Record<string, string> = {
    SessionStart:
      "does not fire. 15 interactive sessions produced 15 SessionEnd and 0 " +
      "SessionStart, with both registered side by side in settings.json",
    PermissionDenied:
      "does not fire, on either denial path: a human pressing Esc at the " +
      "dialog, or a permissions.deny rule blocking the tool. 42 " +
      "PermissionRequest, 0 PermissionDenied",
    Elicitation: "requires an MCP server that elicits input mid-turn; none configured here",
    ElicitationResult: "same, plus a reply to it",
  };

  it("is exactly the list we think it is", () => {
    const missing = Object.keys(EXPECTED)
      .filter((hook) => !recorded.has(hook))
      .sort();
    expect(missing).toEqual(Object.keys(UNCAPTURED).sort());
  });

  it("every admission names a hook the mapping actually handles", () => {
    // Otherwise the list rots into an excuse for hooks that no longer exist.
    for (const hook of Object.keys(UNCAPTURED)) {
      expect(EXPECTED, `${hook} is admitted as uncaptured but is not in EXPECTED`).toHaveProperty(
        hook,
      );
    }
  });
});
