import { describe, expect, it } from "vitest";
import { shouldWrite } from "../src/record.ts";

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
