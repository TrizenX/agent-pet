import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeAdapter } from "@agent-pet/adapter-claude-code/mapping";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../packages/pet-core/src/sessions/registry.ts";

/**
 * What the pet says after you decline a permission prompt.
 *
 * TZX-96. Every other test in this project feeds the machine events we wrote.
 * This one feeds it the payloads a real Claude Code sent, through the real
 * adapter, in the real order a real denial produced — because the bug lived
 * exactly in that join and each layer was correct on its own.
 *
 * The sequence was measured, isolated to a throwaway project so a concurrent
 * session could not pollute it:
 *
 *     18:14:20  UserPromptSubmit
 *     18:14:24  PreToolUse         Bash
 *     18:14:24  PermissionRequest  Bash
 *     18:15:07  SessionEnd
 *
 * Nothing between the request and the end of the session. No `PermissionDenied`
 * — it does not fire, on either denial path. No `PostToolUse`, because the tool
 * never ran. No `Stop`, confirmed with a forty-second settle.
 *
 * So `PreToolUse` drove the pet to `working` and nothing took it out, and it
 * spent the full 300 s watchdog naming the command that had just been refused
 * before falling asleep in front of a user who was sitting right there.
 */

const FIXTURES = join(
  fileURLToPath(new URL("../packages/adapter-claude-code/test/fixtures", import.meta.url)),
);
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

/** The recorded `PermissionRequest` that was a dialog on someone's screen. */
const asking = [1, 2, 3]
  .map((n) => load(`PermissionRequest-${n}.json`))
  .find((r) => (r.permission_suggestions ?? []).length > 0);

/** And one the permission system waved straight through. */
const quiet = [1, 2, 3]
  .map((n) => load(`PermissionRequest-${n}.json`))
  .find((r) => (r.permission_suggestions ?? []).length === 0);

const T0 = 1_700_000_000_000;
const SID = "denial";

function feed(registry: SessionRegistry, raw: unknown, at: number): void {
  for (const e of claudeCodeAdapter.toPetEvents(
    { ...(raw as object), session_id: SID },
    {
      receivedAt: at,
    },
  )) {
    registry.handle(e);
  }
}

function stateAfterDenial(): string {
  const r = new SessionRegistry();
  feed(r, load("UserPromptSubmit-1.json"), T0);
  feed(r, load("PreToolUse-1.json"), T0 + 1_000);
  feed(r, asking, T0 + 1_100);
  return r.snapshot().focused?.state ?? "none";
}

describe("declining a permission prompt", () => {
  it("has both recorded shapes to work with", () => {
    // Without these the tests below would pass while testing nothing.
    expect(asking, "no recorded PermissionRequest with suggestions").toBeTruthy();
    expect(quiet, "no recorded PermissionRequest without suggestions").toBeTruthy();
  });

  it("leaves the pet asking, not claiming to work", () => {
    // The bug: `working.digging`, naming the refused command, for five minutes.
    const state = stateAfterDenial();
    expect(state).toBe("waiting_approval");
    expect(state).not.toMatch(/^working/);
  });

  it("does not claim an activity it can no longer see happening", () => {
    const r = new SessionRegistry();
    feed(r, load("UserPromptSubmit-1.json"), T0);
    feed(r, load("PreToolUse-1.json"), T0 + 1_000);
    const working = r.snapshot().focused;
    // Precondition: the tool call really did set an activity, or the assertion
    // below proves nothing.
    expect(working?.activity, "PreToolUse did not set an activity to begin with").toBeTruthy();

    feed(r, asking, T0 + 1_100);
    expect(r.snapshot().focused?.activity).toBeNull();
  });

  it("still shows ordinary tool calls as work, not as questions", () => {
    // The opposite bug, and the one that shipped for five milestones: mapping
    // every PermissionRequest to APPROVAL_NEEDED parked the pet in
    // waiting_approval and hid the working states entirely.
    const r = new SessionRegistry();
    feed(r, load("UserPromptSubmit-1.json"), T0);
    feed(r, load("PreToolUse-1.json"), T0 + 1_000);
    feed(r, quiet, T0 + 1_100);
    expect(r.snapshot().focused?.state).toMatch(/^working/);
  });

  it("recovers to the user's turn when the agent answers instead", () => {
    // A plain refusal the model reacts to ends the turn, and `Stop` arrives.
    // Checked so the fix is not resting on the decay timer.
    const r = new SessionRegistry();
    feed(r, load("UserPromptSubmit-1.json"), T0);
    feed(r, load("PreToolUse-1.json"), T0 + 1_000);
    feed(r, asking, T0 + 1_100);
    feed(r, load("Stop-1.json"), T0 + 3_000);
    expect(r.snapshot().focused?.state).not.toMatch(/^working/);
  });
});
