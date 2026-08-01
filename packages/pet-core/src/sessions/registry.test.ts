import { PET_EVENT_VERSION, type PetEvent, type PetEventBody } from "@agent-pet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EVICT_AFTER_MS, SessionRegistry } from "./registry.ts";

const T0 = 1_700_000_000_000;

function ev(sessionId: string, body: PetEventBody, at = T0, project?: string): PetEvent {
  return {
    v: PET_EVENT_VERSION,
    source: "test",
    sessionId,
    at,
    ...(project === undefined ? {} : { project }),
    ...body,
  };
}

let registry: SessionRegistry;
const make = () => {
  registry = new SessionRegistry();
  return registry;
};

afterEach(() => registry?.clear());

describe("routing", () => {
  it("gives each session its own state", () => {
    const r = make();
    r.handle(ev("a", { type: "SESSION_START" }));
    r.handle(ev("b", { type: "SESSION_START" }));
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }));
    r.handle(ev("b", { type: "TOOL_START", tool: "file_edit" }));

    const byId = new Map(r.snapshot().sessions.map((s) => [s.sessionId, s.state]));
    expect(byId.get("a")).toBe("working.digging");
    expect(byId.get("b")).toBe("working.typing");
  });

  it("does not thrash: one session's events never move another", () => {
    // The failure this whole issue exists to prevent. Session A waits for an
    // approval while B keeps working; A must still be waiting afterwards.
    const r = make();
    r.handle(ev("a", { type: "APPROVAL_NEEDED" }, T0, "acme-api"));
    for (let i = 1; i <= 20; i++) {
      r.handle(ev("b", { type: "TOOL_START", tool: "bash" }, T0 + i, "other-repo"));
      r.handle(ev("b", { type: "TOOL_DONE", ok: true, tool: "bash" }, T0 + i));
    }

    const a = r.snapshot().sessions.find((s) => s.sessionId === "a");
    expect(a?.state).toBe("waiting_approval");
    expect(r.focusedState()).toBe("waiting_approval");
  });

  it("creates a session on its first event, whatever that event is", () => {
    const r = make();
    r.handle(ev("late", { type: "TOOL_START", tool: "bash" }));
    expect(r.size).toBe(1);
    expect(r.focusedState()).toBe("working.digging");
  });

  it("remembers the project and does not forget it on later events", () => {
    const r = make();
    r.handle(ev("a", { type: "SESSION_START" }, T0, "acme-api"));
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0 + 1));
    expect(r.snapshot().sessions[0]?.project).toBe("acme-api");
  });

  it("surfaces why a session is blocked", () => {
    const r = make();
    r.handle(ev("a", { type: "AGENT_BLOCKED", reason: "rate_limit" }));
    expect(r.snapshot().focused?.blockedReason).toBe("rate_limit");
  });
});

describe("focus across live sessions", () => {
  it("follows the most recent session while nothing needs the user", () => {
    const r = make();
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0, "acme-api"));
    r.handle(ev("b", { type: "TOOL_START", tool: "file_edit" }, T0 + 5, "other-repo"));

    const snap = r.snapshot();
    expect(snap.focused?.sessionId).toBe("b");
    expect(snap.label).toBe("other-repo");
  });

  it("switches to the blocked session and names its project", () => {
    const r = make();
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0, "acme-api"));
    r.handle(ev("b", { type: "APPROVAL_NEEDED" }, T0 + 1, "other-repo"));
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0 + 99));

    const snap = r.snapshot();
    expect(snap.focused?.sessionId).toBe("b");
    expect(snap.label).toBe("other-repo");
    expect(snap.liveCount).toBe(2);
  });

  it("hides the project label while only one session is live", () => {
    const r = make();
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0, "acme-api"));
    expect(r.snapshot().label).toBeUndefined();
  });

  it("gives the pet somewhere to be before anything has happened", () => {
    expect(make().focusedState()).toBe("sleeping");
  });

  it("stamps attentionSince on entry and clears it on resolution", () => {
    const r = make();
    r.handle(ev("a", { type: "APPROVAL_NEEDED" }, T0));
    expect(r.snapshot().focused?.attentionSince).toBe(T0);

    // Later chatter must not reset the clock; it decides who waited longest.
    r.handle(ev("a", { type: "APPROVAL_NEEDED" }, T0 + 5_000));
    expect(r.snapshot().focused?.attentionSince).toBe(T0);

    r.handle(ev("a", { type: "APPROVAL_RESOLVED", granted: true }, T0 + 6_000));
    expect(r.snapshot().sessions[0]?.attentionSince).toBeUndefined();
  });

  it("shows whoever has been waiting longest when two are blocked", () => {
    const r = make();
    r.handle(ev("first", { type: "APPROVAL_NEEDED" }, T0, "one"));
    r.handle(ev("second", { type: "AGENT_BLOCKED", reason: "rate_limit" }, T0 + 1_000, "two"));
    expect(r.snapshot().focused?.sessionId).toBe("first");
  });
});

describe("eviction keeps memory flat (M2 soak criterion)", () => {
  it("drops a session that has gone quiet", () => {
    const r = make();
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0));
    expect(r.size).toBe(1);

    expect(r.tick(T0 + EVICT_AFTER_MS - 1)).toEqual([]);
    expect(r.tick(T0 + EVICT_AFTER_MS)).toEqual(["a"]);
    expect(r.size).toBe(0);
  });

  it("keeps an active session", () => {
    const r = make();
    for (let i = 0; i < 5; i++) {
      const at = T0 + i * EVICT_AFTER_MS * 0.5;
      r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, at));
      r.tick(at);
    }
    expect(r.size).toBe(1);
  });

  it("stays flat across a workday's worth of sessions", () => {
    const r = make();
    // 25 sessions, each active for a while and then abandoned.
    for (let i = 0; i < 25; i++) {
      const at = T0 + i * 60_000;
      r.handle(ev(`s${i}`, { type: "SESSION_START" }, at));
      r.handle(ev(`s${i}`, { type: "TOOL_START", tool: "bash" }, at + 1));
      r.tick(at + 2);
    }
    // Only those inside the eviction window survive.
    expect(r.size).toBeLessThanOrEqual(Math.ceil(EVICT_AFTER_MS / 60_000) + 1);

    r.tick(T0 + 25 * 60_000 + EVICT_AFTER_MS);
    expect(r.size).toBe(0);
  });

  it("will not drop a session that is still asking the user for something", () => {
    // The user went to lunch with an approval on screen. Evicting it would
    // erase the request exactly when they are away from the machine.
    const r = make();
    r.handle(ev("a", { type: "APPROVAL_NEEDED" }, T0));
    expect(r.tick(T0 + EVICT_AFTER_MS * 3)).toEqual([]);
    expect(r.size).toBe(1);
    expect(r.focusedState()).toBe("waiting_approval");
  });

  it("evicts it once the machine's own decay releases it", () => {
    // Which is why the exemption cannot leak: the machine always lets go.
    const r = make();
    r.handle(ev("a", { type: "APPROVAL_NEEDED" }, T0));
    r.handle(ev("a", { type: "AGENT_IDLE" }, T0 + 1));
    expect(r.tick(T0 + EVICT_AFTER_MS + 1)).toEqual(["a"]);
    expect(r.size).toBe(0);
  });

  it("clear() stops every actor", () => {
    const r = make();
    for (let i = 0; i < 5; i++) r.handle(ev(`s${i}`, { type: "SESSION_START" }));
    r.clear();
    expect(r.size).toBe(0);
    expect(r.focusedState()).toBe("sleeping");
  });
});

describe("the watchdog reaches every session", () => {
  it("sweeps a session the agent abandoned mid-tool-call", () => {
    const r = make();
    r.handle(ev("a", { type: "TOOL_START", tool: "bash" }, T0));
    r.handle(ev("b", { type: "TOOL_START", tool: "bash" }, T0));

    // Far enough for the machine's watchdog, not far enough to evict.
    r.tick(T0 + EVICT_AFTER_MS - 1);
    for (const s of r.snapshot().sessions) expect(s.state).toBe("sleeping");
  });

  it("does not count a tick as activity", () => {
    // Otherwise ticking would keep dead sessions alive forever.
    const r = make();
    r.handle(ev("a", { type: "SESSION_START" }, T0));
    for (let t = 0; t < EVICT_AFTER_MS; t += 30_000) r.tick(T0 + t);
    expect(r.tick(T0 + EVICT_AFTER_MS)).toEqual(["a"]);
  });
});
