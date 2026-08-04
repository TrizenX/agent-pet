import { describe, expect, it } from "vitest";
import { redact, shouldWrite } from "../src/record.ts";

/**
 * The recorder's write rules.
 *
 * These exist because the default output directory is `test/fixtures` — the
 * committed, redacted, reviewed set — and a capture run that quietly replaced
 * files in it would produce a diff nobody would read against payloads nobody
 * chose. Two of the three rules are there to stop that; the third is what makes
 * a long capture run worth leaving on.
 */

const none = {};

describe("shouldWrite", () => {
  it("writes a payload nobody has recorded yet", () => {
    expect(shouldWrite("SessionStart", 1, false, none)).toEqual({ write: true });
  });

  it("refuses to overwrite an existing fixture", () => {
    const v = shouldWrite("PreToolUse", 1, true, none);
    expect(v.write).toBe(false);
    expect(v.reason).toMatch(/--force/);
  });

  it("overwrites when asked explicitly — re-recording is a stated purpose", () => {
    expect(shouldWrite("PreToolUse", 1, true, { force: true })).toEqual({ write: true });
  });

  it("keeps at most three of any one hook", () => {
    expect(shouldWrite("PreToolUse", 3, false, none).write).toBe(true);
    expect(shouldWrite("PreToolUse", 4, false, none).write).toBe(false);
  });

  it("drops everything outside --only", () => {
    const only = new Set(["SessionStart", "StopFailure"]);
    expect(shouldWrite("SessionStart", 1, false, { only }).write).toBe(true);
    expect(shouldWrite("PreToolUse", 1, false, { only }).write).toBe(false);
  });

  it("treats an empty --only as no filter, not as a filter matching nothing", () => {
    // The CLI always passes a Set. If empty meant "capture nothing", every run
    // without the flag would silently record zero payloads and look like a
    // session where no hooks fired.
    expect(shouldWrite("PreToolUse", 1, false, { only: new Set() }).write).toBe(true);
  });

  it("filters before counting, so a filtered hook cannot use up slots", () => {
    const only = new Set(["StopFailure"]);
    expect(shouldWrite("PreToolUse", 99, false, { only })).toEqual({
      write: false,
      reason: "not in --only",
    });
  });

  it("says why it skipped, every time", () => {
    // A silent skip is indistinguishable from a hook that never fired, which is
    // the exact ambiguity a capture run cannot afford.
    for (const v of [
      shouldWrite("X", 1, true, none),
      shouldWrite("X", 9, false, none),
      shouldWrite("X", 1, false, { only: new Set(["Y"]) }),
    ]) {
      expect(v.write).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });
});

/**
 * Redaction has to hide prose and keep enums, and `error` is both depending on
 * which hook it came from. These are the real strings from real payloads.
 */
describe("redact", () => {
  it("keeps an enum-shaped error, because that is the reason the pet reports", () => {
    // The actual value from the first StopFailure ever recorded. Redacting it to
    // <redacted:string:21> is how nobody noticed the mapping read error_type,
    // a field the payload does not have.
    expect(redact("authentication_failed", "error")).toBe("authentication_failed");
    expect(redact("rate_limit", "error")).toBe("rate_limit");
  });

  it("still hides an error that is prose", () => {
    // PostToolUseFailure's `error` is a tool's message and can carry paths.
    expect(redact("Error: /Users/hello/secret.ts failed to parse", "error")).toMatch(
      /^<redacted:string:\d+>$/,
    );
    expect(redact("Command timed out", "error")).toMatch(/^<redacted:string:\d+>$/);
    // Capitals alone are enough to disqualify it — an enum here is lower snake.
    expect(redact("Authentication_Failed", "error")).toMatch(/^<redacted:string:\d+>$/);
  });

  it("does not let the enum rule leak to arbitrary fields", () => {
    expect(redact("authentication_failed", "last_assistant_message")).toMatch(
      /^<redacted:string:\d+>$/,
    );
  });

  it("replaces identifying fields with stable placeholders", () => {
    expect(redact("/Users/hello/Project/secret", "cwd")).toBe("/home/user/demo-project");
    expect(redact("dd7d858f-3920-437e-8c92-9ab2c68c50c0", "session_id")).toBe("session-0000");
  });

  it("walks nested objects and arrays", () => {
    const out = redact({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      effort: { level: "high" },
      permission_suggestions: [{ ruleContent: "rm -rf /Users/hello" }],
    }) as Record<string, unknown>;
    expect(out.hook_event_name).toBe("StopFailure");
    expect(out.error).toBe("rate_limit");
    // `level` is enum-like and in the allowlist, so it survives — it says which
    // effort the blocked turn was running at, and carries nothing personal.
    expect(out.effort).toEqual({ level: "high" });
    expect(JSON.stringify(out)).not.toContain("/Users/hello");
  });
});
