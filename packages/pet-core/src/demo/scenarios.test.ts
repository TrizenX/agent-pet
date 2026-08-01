import { afterEach, describe, expect, it } from "vitest";
import type { PetState } from "../packs/stateMap.ts";
import { SessionRegistry } from "../sessions/registry.ts";
import { SCENARIOS, scenarioById, timeline } from "./scenarios.ts";

const T0 = 1_700_000_000_000;

let registry: SessionRegistry | undefined;
afterEach(() => registry?.clear());

/** Replay a scenario into a registry and collect the state after each beat. */
function replay(id: string): { states: PetState[]; registry: SessionRegistry } {
  const scenario = scenarioById(id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  const reg = new SessionRegistry();
  registry = reg;
  const states = timeline(scenario, T0).map((event) => {
    reg.handle(event);
    return reg.focusedState();
  });
  return { states, registry: reg };
}

describe("scenarios are well-formed", () => {
  it("covers the five the tray offers", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      "full",
      "approval",
      "rate-limit",
      "error",
      "multi",
    ]);
  });

  it("never moves time backwards", () => {
    for (const scenario of SCENARIOS) {
      const times = timeline(scenario, T0).map((e) => e.at);
      expect(
        [...times].sort((a, b) => a - b),
        scenario.id,
      ).toEqual(times);
    }
  });

  it("produces valid wire events", () => {
    for (const scenario of SCENARIOS) {
      for (const event of timeline(scenario, T0)) {
        expect(event.v, scenario.id).toBe(1);
        expect(event.sessionId).toBeTruthy();
        expect(event.source).toBe("demo");
      }
    }
  });
});

describe("scenarios drive the real pipeline", () => {
  it("`full` reaches a celebration, because the demo has to earn it too", () => {
    // celebrationWorthy needs a tool and fifteen seconds; a demo that skipped
    // the guard would be demonstrating something the product does not do.
    const { states } = replay("full");
    expect(states).toContain("working.reading");
    expect(states).toContain("working.digging");
    expect(states).toContain("working.typing");
    expect(states).toContain("celebrating");
    expect(states.at(-1)).toBe("sleeping");
  });

  it("`approval` shows the wave and then resumes", () => {
    const { states } = replay("approval");
    expect(states).toContain("waiting_approval");
    expect(states.indexOf("working.generic")).toBeGreaterThan(states.indexOf("waiting_approval"));
  });

  it("`rate-limit` reaches exhausted and recovers on the next prompt", () => {
    const { states } = replay("rate-limit");
    expect(states).toContain("exhausted");
    expect(states.at(-1)).toBe("attentive");
  });

  it("`error` distinguishes a failure from an interruption", () => {
    const { states } = replay("error");
    expect(states).toContain("error");
    // The final beat is interrupted, which must not read as a failure.
    expect(states.at(-1)).toBe("idle");
  });

  it("`multi` demonstrates the focus policy rather than just two sessions", () => {
    const { states, registry: reg } = replay("multi");
    const snap = reg.snapshot();
    expect(snap.liveCount).toBe(2);

    // The whole point: session 2 keeps working while session 1 waits, and the
    // pet stays on session 1.
    const approvalAt = states.indexOf("waiting_approval");
    expect(approvalAt).toBeGreaterThanOrEqual(0);
    expect(states.slice(approvalAt, -1).every((s) => s === "waiting_approval")).toBe(true);
  });

  it("`multi` labels the focused project once two are live", () => {
    const { registry: reg } = replay("multi");
    expect(reg.snapshot().label).toBeTruthy();
  });
});

describe("every state the renderer can draw is demonstrable", () => {
  it("reaches all of them across the five scenarios", () => {
    // App Review, and marketing GIFs, need every state reachable with no agent
    // installed — that is half the reason demo mode exists.
    const seen = new Set<PetState>();
    for (const scenario of SCENARIOS) {
      for (const state of replay(scenario.id).states) seen.add(state);
      registry?.clear();
    }
    for (const state of [
      "idle",
      "attentive",
      "working.digging",
      "working.typing",
      "working.reading",
      "waiting_approval",
      "error",
      "exhausted",
      "celebrating",
      "sleeping",
    ] as PetState[]) {
      expect(seen.has(state), `${state} is not demonstrable`).toBe(true);
    }
  });
});
