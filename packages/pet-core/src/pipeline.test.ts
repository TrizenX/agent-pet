import { PET_EVENT_VERSION } from "@agent-pet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ingest, ingestInto, PRE_NORMALISED_SOURCE } from "./pipeline.ts";
import { SessionRegistry } from "./sessions/registry.ts";

const T0 = 1_700_000_000_000;
const raw = (source: string, payload: unknown) => ({
  source,
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  at: T0,
});

let registry: SessionRegistry | undefined;
afterEach(() => registry?.clear());

describe("ingest", () => {
  it("maps a real agent payload through its adapter", () => {
    const out = ingest(
      raw("claude-code", {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/w/acme-api",
        tool_name: "Bash",
      }),
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ type: "TOOL_START", tool: "bash", project: "acme-api" });
  });

  it("stamps the receive time rather than trusting the payload", () => {
    const out = ingest(raw("claude-code", { hook_event_name: "Stop", session_id: "s1" }));
    expect(out.events[0]?.at).toBe(T0);
  });

  it("accepts a pre-normalised event without an adapter", () => {
    const event = {
      v: PET_EVENT_VERSION,
      source: "demo",
      sessionId: "d1",
      at: T0,
      type: "AGENT_BLOCKED",
      reason: "rate_limit",
    };
    expect(ingest(raw(PRE_NORMALISED_SOURCE, event)).events).toEqual([event]);
  });

  it("still validates a pre-normalised event — the claim is not a fact", () => {
    const out = ingest(raw(PRE_NORMALISED_SOURCE, { type: "TOTALLY_MADE_UP" }));
    expect(out.events).toEqual([]);
    expect(out.dropped).toBe("not-a-pet-event");
  });

  it("rejects a wire version it does not know", () => {
    const out = ingest(
      raw(PRE_NORMALISED_SOURCE, {
        v: 99,
        source: "x",
        sessionId: "s",
        at: T0,
        type: "AGENT_IDLE",
      }),
    );
    expect(out.dropped).toBe("not-a-pet-event");
  });

  it("drops a payload from an agent we do not support, and says so", () => {
    const out = ingest(raw("some-future-agent", { anything: true }));
    expect(out).toEqual({ events: [], dropped: "unknown-source" });
  });

  it("survives whatever the endpoint let through", () => {
    // The server answers 204 to anything (I1), so anything can arrive here.
    for (const payload of ["not json", "", "{", "[1,2,3]"]) {
      const out = ingest({ source: "claude-code", payload, at: T0 });
      expect(() => out).not.toThrow();
      expect(out.events).toEqual([]);
    }
    expect(ingest({ source: "claude-code", payload: "oops", at: T0 }).dropped).toBe("unparseable");
  });

  it("reports a hook the adapter has no opinion about", () => {
    const out = ingest(
      raw("claude-code", {
        hook_event_name: "Notification",
        session_id: "s1",
        notification_type: "auth_success",
      }),
    );
    expect(out).toEqual({ events: [], dropped: "no-events" });
  });
});

describe("ingestInto", () => {
  it("drives the pet end to end from a raw payload", () => {
    registry = new SessionRegistry();
    ingestInto(
      registry,
      raw("claude-code", {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/w/acme-api",
        tool_name: "Edit",
      }),
    );
    expect(registry.focusedState()).toBe("working.typing");
  });

  it("keeps two agents' sessions apart", () => {
    registry = new SessionRegistry();
    ingestInto(
      registry,
      raw("claude-code", {
        hook_event_name: "Notification",
        session_id: "a",
        cwd: "/w/one",
        notification_type: "permission_prompt",
      }),
    );
    ingestInto(
      registry,
      raw("claude-code", {
        hook_event_name: "PreToolUse",
        session_id: "b",
        cwd: "/w/two",
        tool_name: "Bash",
      }),
    );

    const snap = registry.snapshot();
    expect(snap.liveCount).toBe(2);
    // Attention outranks the more recent session.
    expect(snap.focused?.sessionId).toBe("a");
    expect(snap.label).toBe("one");
  });

  it("leaves the registry untouched when nothing maps", () => {
    registry = new SessionRegistry();
    ingestInto(registry, { source: "claude-code", payload: "garbage", at: T0 });
    expect(registry.size).toBe(0);
  });
});
