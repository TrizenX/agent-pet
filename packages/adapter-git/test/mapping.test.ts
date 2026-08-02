import { describe, expect, it } from "vitest";
import { gitAdapter } from "../src/mapping.ts";

const at = 1_000;
const map = (raw: unknown) => gitAdapter.toPetEvents(raw, { receivedAt: at });
const one = (raw: unknown) => {
  const events = map(raw);
  expect(events).toHaveLength(1);
  return events[0];
};

describe("the repository is the session", () => {
  it("keys events by the repository path", () => {
    // Git hooks are separate processes with no shared identity, and two commits
    // an hour apart in the same checkout are one piece of work to a pet.
    expect(one({ event: "post-commit", repo: "/home/me/viparse" })).toMatchObject({
      sessionId: "/home/me/viparse",
      project: "viparse",
      source: "git",
    });
  });

  it("drops an event with no repository rather than inventing a session", () => {
    expect(map({ event: "post-commit" })).toEqual([]);
    expect(map({ event: "post-commit", repo: "" })).toEqual([]);
  });

  it("ignores anything that is not an object", () => {
    for (const junk of [null, undefined, 7, "post-commit", []]) {
      expect(map(junk)).toEqual([]);
    }
  });
});

describe("git's moments, in the pet's vocabulary", () => {
  it("brackets a commit", () => {
    expect(one({ event: "pre-commit", repo: "/r", branch: "main" })).toMatchObject({
      type: "TOOL_START",
      tool: "file_edit",
      label: "main",
    });
    // TURN_END rather than anything triumphant: whether it earns a trophy is
    // the machine's decision, per D5, not the adapter's.
    expect(one({ event: "post-commit", repo: "/r" })).toMatchObject({ type: "TURN_END" });
  });

  it("shows a push as network work, named by its remote", () => {
    expect(one({ event: "pre-push", repo: "/r", remote: "origin" })).toMatchObject({
      type: "TOOL_START",
      tool: "network",
      label: "origin",
    });
  });

  it("covers the moments that rewrite the tree under you", () => {
    expect(one({ event: "post-merge", repo: "/r" })).toMatchObject({ type: "TOOL_DONE", ok: true });
    expect(one({ event: "post-rewrite", repo: "/r" })).toMatchObject({ label: "rebase" });
    expect(one({ event: "post-checkout", repo: "/r" })).toMatchObject({ type: "TOOL_DONE" });
  });

  it("says nothing about hooks it has no opinion on", () => {
    // Git grows hooks and the pet must not break when it does.
    expect(map({ event: "pre-receive", repo: "/r" })).toEqual([]);
    expect(map({ event: "whatever-comes-next", repo: "/r" })).toEqual([]);
  });

  it("truncates a branch name rather than letting it run", () => {
    const long = "feature/".padEnd(80, "x");
    const e = one({ event: "pre-commit", repo: "/r", branch: long }) as { label: string };
    expect(e.label.length).toBeLessThanOrEqual(24);
    expect(e.label.endsWith("…")).toBe(true);
  });
});

describe("the contract the registry relies on", () => {
  it("is pure — same input, same output, no clock read", () => {
    const raw = { event: "post-commit", repo: "/r" };
    expect(gitAdapter.toPetEvents(raw, { receivedAt: 1 })).toEqual([
      { v: 1, source: "git", sessionId: "/r", project: "r", at: 1, type: "TURN_END" },
    ]);
    expect(gitAdapter.toPetEvents(raw, { receivedAt: 2 })[0]?.at).toBe(2);
  });

  it("offers a hook config that is a script, not a settings blob", () => {
    // The shape of this is the finding: the contract's `hookConfig` assumes
    // configuration is something you paste, and git's is something you run.
    const cfg = gitAdapter.hookConfig?.("http://127.0.0.1:48200/event/git") ?? "";
    expect(cfg).toContain(".git/hooks/");
    expect(cfg).toContain("chmod +x");
    expect(() => JSON.parse(cfg)).toThrow();
  });
});
