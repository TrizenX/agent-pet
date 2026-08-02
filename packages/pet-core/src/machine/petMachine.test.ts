import {
  PET_EVENT_VERSION,
  type PetEvent,
  type PetEventBody,
  type ToolKind,
} from "@agent-pet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import { type PetState, STATE_ANIMATIONS } from "../packs/stateMap.ts";
import {
  celebrationWorthy,
  DELAYS,
  type PetMachineEvent,
  petMachine,
  toPetState,
} from "./petMachine.ts";

const T0 = 1_700_000_000_000;

// `Omit` distributes badly over a discriminated union, losing every member's
// own fields. The body type is the right input here.
function ev(body: PetEventBody, at = T0): PetEvent {
  return { v: PET_EVENT_VERSION, source: "test", sessionId: "s1", at, ...body };
}

const start = () => ev({ type: "SESSION_START" });
const prompt = (at = T0) => ev({ type: "PROMPT_SUBMITTED" }, at);
const tool = (t: ToolKind = "bash", at = T0) => ev({ type: "TOOL_START", tool: t }, at);
const done = (ok: boolean, extra: { interrupted?: boolean } = {}) =>
  ev({ type: "TOOL_DONE", ok, tool: "bash", ...extra });

/** Drive the machine through a list of events and report where it lands. */
function run(events: PetMachineEvent[]): {
  state: PetState;
  actor: ReturnType<typeof createActor>;
} {
  const actor = createActor(petMachine).start();
  for (const e of events) actor.send(e);
  return { state: toPetState(actor.getSnapshot().value), actor };
}

const stateAfter = (events: PetMachineEvent[]) => run(events).state;

/** Every leaf state, and the shortest route to it. */
const ROUTES: ReadonlyArray<[PetState, PetMachineEvent[]]> = [
  ["sleeping", []],
  ["idle", [start()]],
  ["attentive", [start(), prompt()]],
  ["working.digging", [start(), tool("bash")]],
  ["working.typing", [start(), tool("file_edit")]],
  ["working.reading", [start(), tool("file_read")]],
  ["working.generic", [start(), tool("other")]],
  ["working.delegating", [start(), tool("delegate")]],
  ["compacting", [start(), ev({ type: "COMPACTING" })]],
  ["waiting_input", [start(), ev({ type: "INPUT_NEEDED" })]],
  ["waiting_approval", [start(), ev({ type: "APPROVAL_NEEDED" })]],
  ["error", [start(), tool("bash"), done(false)]],
  ["exhausted", [start(), ev({ type: "AGENT_BLOCKED", reason: "rate_limit" })]],
  [
    "celebrating",
    [start(), prompt(T0), tool("bash", T0 + 1), ev({ type: "TURN_END" }, T0 + 20_000)],
  ],
];

/**
 * States the watchdog must not sweep: the pet is asking the user for something,
 * and five quiet minutes usually means they stepped away — which is exactly
 * when the request most needs to survive.
 */
const ATTENTION_EXEMPT: readonly string[] = [
  "sleeping",
  "waiting_approval",
  "waiting_input",
  "exhausted",
];

describe("reachability", () => {
  it.each(ROUTES)("%s is reachable", (want, events) => {
    expect(stateAfter(events)).toBe(want);
  });

  it("covers every state the renderer knows how to draw", () => {
    // If stateMap gains a state and the machine cannot reach it, the renderer
    // has an animation nothing will ever trigger.
    const reachable = new Set(ROUTES.map(([s]) => s));
    for (const state of Object.keys(STATE_ANIMATIONS) as PetState[]) {
      expect(reachable.has(state), `${state} is unreachable`).toBe(true);
    }
  });
});

describe("§7.2 — root transitions apply from every state (I3)", () => {
  const PREEMPTING: ReadonlyArray<[string, PetMachineEvent, PetState]> = [
    ["SESSION_END", ev({ type: "SESSION_END" }), "sleeping"],
    ["AGENT_IDLE", ev({ type: "AGENT_IDLE" }), "idle"],
    ["PROMPT_SUBMITTED", prompt(), "attentive"],
    ["APPROVAL_NEEDED", ev({ type: "APPROVAL_NEEDED" }), "waiting_approval"],
    ["AGENT_BLOCKED", ev({ type: "AGENT_BLOCKED", reason: "overloaded" }), "exhausted"],
    ["TOOL_START", tool("bash"), "working.digging"],
  ];

  // The three states most likely to swallow an event are exactly the ones with
  // their own timers, so every route is checked against every event.
  for (const [from, route] of ROUTES) {
    for (const [name, event, want] of PREEMPTING) {
      it(`${from} + ${name} -> ${want}`, () => {
        expect(stateAfter([...route, event])).toBe(want);
      });
    }
  }
});

describe("§7.2 — per-state transitions", () => {
  it("a failing tool sends the pet to error", () => {
    expect(stateAfter([start(), tool("bash"), done(false)])).toBe("error");
  });

  it("a successful tool keeps it working, and bumps the hop counter", () => {
    const { actor, state } = run([start(), tool("file_edit"), done(true), done(true)]);
    expect(state).toBe("working.typing");
    expect(actor.getSnapshot().context.hopCount).toBe(2);
  });

  it("an interrupted tool goes to idle, not error (Spike B · B3)", () => {
    // Pressing ctrl-c is not the tool breaking; the pet must not fall over.
    expect(stateAfter([start(), tool("bash"), done(false, { interrupted: true })])).toBe("idle");
  });

  it("granted approval resumes work; denied approval returns to idle", () => {
    const approve = ev({ type: "APPROVAL_RESOLVED", granted: true });
    const deny = ev({ type: "APPROVAL_RESOLVED", granted: false });
    expect(stateAfter([start(), ev({ type: "APPROVAL_NEEDED" }), approve])).toBe("working.generic");
    expect(stateAfter([start(), ev({ type: "APPROVAL_NEEDED" }), deny])).toBe("idle");
  });

  it("a tool starting while waiting counts as approval granted", () => {
    expect(stateAfter([start(), ev({ type: "APPROVAL_NEEDED" }), tool("bash")])).toBe(
      "working.digging",
    );
  });

  it("records and clears why the agent is blocked", () => {
    const { actor } = run([start(), ev({ type: "AGENT_BLOCKED", reason: "billing" })]);
    expect(actor.getSnapshot().context.blockedReason).toBe("billing");
    actor.send(prompt());
    expect(actor.getSnapshot().context.blockedReason).toBeNull();
  });
});

describe("celebrationWorthy (D5)", () => {
  const turnEnd = (at: number) => ev({ type: "TURN_END" }, at);

  it("a long turn that used tools and did not fail earns a celebration", () => {
    expect(stateAfter([start(), prompt(T0), tool("bash", T0 + 1), turnEnd(T0 + 20_000)])).toBe(
      "celebrating",
    );
  });

  it("a bare question does not — answering is not an achievement", () => {
    expect(stateAfter([start(), prompt(T0), turnEnd(T0 + 60_000)])).toBe("idle");
  });

  it("a fast turn does not, even with a tool call", () => {
    expect(stateAfter([start(), prompt(T0), tool("bash", T0 + 1), turnEnd(T0 + 3_000)])).toBe(
      "idle",
    );
  });

  it("a turn that failed does not", () => {
    expect(
      stateAfter([start(), prompt(T0), tool("bash", T0 + 1), done(false), turnEnd(T0 + 20_000)]),
    ).toBe("idle");
  });

  it("an interrupted tool does not poison the turn", () => {
    // The user cancelled one command; the rest of the turn can still be good.
    expect(
      stateAfter([
        start(),
        prompt(T0),
        tool("bash", T0 + 1),
        done(false, { interrupted: true }),
        tool("file_edit", T0 + 2),
        turnEnd(T0 + 20_000),
      ]),
    ).toBe("celebrating");
  });

  it("a new prompt resets the turn accounting", () => {
    expect(
      stateAfter([
        start(),
        prompt(T0),
        tool("bash", T0 + 1),
        done(false),
        prompt(T0 + 10_000),
        tool("bash", T0 + 10_001),
        turnEnd(T0 + 40_000),
      ]),
    ).toBe("celebrating");
  });

  it("is a pure function of context and a timestamp", () => {
    const base = {
      lastEventAt: 0,
      turnStartedAt: 0,
      toolsThisTurn: 1,
      hadFailureThisTurn: false,
      hopCount: 0,
      blockedReason: null,
      activity: null,
    };
    expect(celebrationWorthy(base, 15_000)).toBe(true);
    expect(celebrationWorthy(base, 14_999)).toBe(false);
    expect(celebrationWorthy({ ...base, toolsThisTurn: 0 }, 60_000)).toBe(false);
    expect(celebrationWorthy({ ...base, hadFailureThisTurn: true }, 60_000)).toBe(false);
  });
});

describe("§7.2 — decay timers (I4)", () => {
  const DECAYS: ReadonlyArray<[PetState, PetMachineEvent[], number, PetState]> = [
    ["error", [start(), tool("bash"), done(false)], DELAYS.ERROR_DECAY, "idle"],
    [
      "celebrating",
      [start(), prompt(T0), tool("bash", T0 + 1), ev({ type: "TURN_END" }, T0 + 20_000)],
      DELAYS.CELEBRATION,
      "idle",
    ],
    ["idle", [start()], DELAYS.IDLE_TO_SLEEP, "sleeping"],
    [
      "exhausted",
      [start(), ev({ type: "AGENT_BLOCKED", reason: "rate_limit" })],
      DELAYS.EXHAUSTED_DECAY,
      "idle",
    ],
    ["waiting_approval", [start(), ev({ type: "APPROVAL_NEEDED" })], DELAYS.APPROVAL_DECAY, "idle"],
  ];

  it.each(DECAYS)("%s decays to %s", async (from, route, delay, want) => {
    vi.useFakeTimers();
    try {
      const { actor } = run(route);
      expect(toPetState(actor.getSnapshot().value)).toBe(from);
      await vi.advanceTimersByTimeAsync(delay + 50);
      expect(toPetState(actor.getSnapshot().value)).toBe(want);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no state is terminal — every route eventually reaches sleeping", async () => {
    vi.useFakeTimers();
    try {
      for (const [name, route] of ROUTES) {
        const { actor } = run(route);
        // Long enough for the slowest chain: approval -> idle -> sleeping.
        await vi.advanceTimersByTimeAsync(DELAYS.APPROVAL_DECAY + DELAYS.IDLE_TO_SLEEP + 1_000);
        expect(toPetState(actor.getSnapshot().value), `${name} got stuck`).toBe("sleeping");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchdog (I4)", () => {
  const tick = (at: number): PetMachineEvent => ({ type: "WATCHDOG", at });

  it("sweeps a state left behind by a missed hook", () => {
    // The agent died mid-tool-call and the completion event never arrived.
    expect(stateAfter([start(), tool("bash", T0), tick(T0 + DELAYS.WATCHDOG)])).toBe("sleeping");
  });

  it("does nothing while events keep arriving", () => {
    expect(
      stateAfter([
        start(),
        tool("bash", T0),
        tick(T0 + DELAYS.WATCHDOG - 1),
        tool("bash", T0 + DELAYS.WATCHDOG - 1),
        tick(T0 + DELAYS.WATCHDOG),
      ]),
    ).toBe("working.digging");
  });

  it.each([
    ["waiting_approval", ev({ type: "APPROVAL_NEEDED" })],
    ["exhausted", ev({ type: "AGENT_BLOCKED", reason: "rate_limit" })],
    ["waiting_input", ev({ type: "INPUT_NEEDED" })],
  ] as const)("leaves %s alone — silence there is expected, not suspicious", (want, event) => {
    // These are the pet asking the user for something. Sweeping them away
    // after five quiet minutes would hide the request exactly when the user has
    // stepped away and most needs to see it on return.
    expect(stateAfter([start(), event, tick(T0 + DELAYS.WATCHDOG * 10)])).toBe(want);
  });

  it("sweeps every other non-sleeping state", () => {
    const sweepable = ROUTES.filter(([s]) => !ATTENTION_EXEMPT.includes(s));
    for (const [name, route] of sweepable) {
      expect(stateAfter([...route, tick(T0 + DELAYS.WATCHDOG * 10)]), name).toBe("sleeping");
    }
  });
});

describe("toPetState", () => {
  it("flattens nested values the way the renderer expects", () => {
    expect(toPetState("idle")).toBe("idle");
    expect(toPetState({ working: "digging" })).toBe("working.digging");
    expect(toPetState(undefined)).toBe("idle");
  });
});

describe("the activity the pet reports", () => {
  /**
   * Every `TOOL_START` branch, including the fallback.
   *
   * The fallback shipped without `recordActivity` because it was written on one
   * line while its three siblings were multi-line, so a mechanical edit matched
   * them and missed it — the same shape as the `generate_handler!` macro that
   * lost three commands to a reformat. A table is the fix: a new branch that
   * forgets to record is a new row that fails.
   */
  const CASES: ReadonlyArray<[ToolKind, string]> = [
    ["bash", "working.digging"],
    ["file_edit", "working.typing"],
    ["file_read", "working.reading"],
    ["search", "working.reading"],
    ["network", "working.generic"],
    ["delegate", "working.delegating"],
    ["other", "working.generic"],
  ];

  it.each(CASES)("records %s and lands in %s", (tool, expected) => {
    const actor = createActor(petMachine).start();
    actor.send({ type: "TOOL_START", tool, at: 1_000 } as PetMachineEvent);

    expect(toPetState(actor.getSnapshot().value)).toBe(expected);
    expect(actor.getSnapshot().context.activity).toBe(tool);
    actor.stop();
  });

  it("forgets the tool once it finishes, rather than naming a finished one", () => {
    const actor = createActor(petMachine).start();
    actor.send({ type: "TOOL_START", tool: "bash", at: 1_000 } as PetMachineEvent);
    expect(actor.getSnapshot().context.activity).toBe("bash");

    actor.send({ type: "TOOL_DONE", ok: true, tool: "bash", at: 2_000 } as PetMachineEvent);
    expect(actor.getSnapshot().context.activity).toBeNull();
    actor.stop();
  });

  it("stops naming the delegate once the subagent comes back", () => {
    // Caught live: the pet went on saying "sent a friend" after the friend had
    // returned. Every other exit from work clears the activity; this one is a
    // root transition and was written separately, which is how it was missed.
    const actor = createActor(petMachine).start();
    actor.send({ type: "TOOL_START", tool: "delegate", at: 1_000 } as PetMachineEvent);
    expect(toPetState(actor.getSnapshot().value)).toBe("working.delegating");

    actor.send({ type: "SUBAGENT_END", at: 2_000 } as PetMachineEvent);
    expect(toPetState(actor.getSnapshot().value)).toBe("working.generic");
    expect(actor.getSnapshot().context.activity).toBeNull();
    actor.stop();
  });

  it("does not carry an activity out of the work states", () => {
    const actor = createActor(petMachine).start();
    actor.send({ type: "TOOL_START", tool: "network", at: 1_000 } as PetMachineEvent);
    actor.send({ type: "APPROVAL_NEEDED", at: 2_000 } as PetMachineEvent);

    expect(toPetState(actor.getSnapshot().value)).toBe("waiting_approval");
    expect(actor.getSnapshot().context.activity).toBeNull();
    actor.stop();
  });
});
