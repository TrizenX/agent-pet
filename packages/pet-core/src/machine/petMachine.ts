/**
 * The pet's behaviour, as a state machine.
 *
 * Spec §7. Three of the seven hard invariants are enforced by the shape of this
 * file rather than by discipline:
 *
 * **I3 — events preempt animations, always.** Every "from any state" transition
 * lives in the machine's root `on`, so no state can accidentally swallow an
 * event by forgetting to handle it. Adding a state cannot break preemption.
 *
 * **I4 — no state is terminal.** Every non-`sleeping` state has a decay path,
 * and a watchdog catches anything a missed hook leaves behind.
 *
 * **I6 — idle cost is zero.** The machine holds no clock. Elapsed time is read
 * from the `at` field every event already carries, which also makes every
 * timing rule testable without faking a clock.
 */

import type { PetEvent } from "@agent-pet/protocol";
import { assign, setup } from "xstate";
import type { PetState } from "../packs/stateMap.ts";

/**
 * Sent by the host on a slow timer. The machine does not own a clock — a
 * self-driving timer inside the machine would be invisible to tests and would
 * tick even while asleep.
 */
export interface WatchdogTick {
  readonly type: "WATCHDOG";
  readonly at: number;
}

export type PetMachineEvent = PetEvent | WatchdogTick;

export interface PetContext {
  /** `at` of the most recent event. The watchdog's only input. */
  lastEventAt: number;
  /** Reset on every prompt. Feeds `celebrationWorthy`. */
  turnStartedAt: number;
  toolsThisTurn: number;
  hadFailureThisTurn: boolean;
  /** Bumped on each successful tool so the renderer can play a one-shot hop. */
  hopCount: number;
  /** Why the agent is stuck, when it is. */
  blockedReason: string | null;
}

export const DELAYS = {
  /** A tool failure is transient; the agent usually retries immediately. */
  ERROR_DECAY: 3_000,
  CELEBRATION: 4_000,
  IDLE_TO_SLEEP: 90_000,
  /**
   * Longer than the watchdog on purpose: `exhausted` means the agent is stuck
   * and the user has to act, so silence is expected rather than suspicious.
   */
  EXHAUSTED_DECAY: 600_000,
  /**
   * I4 backstop for the one state §7.2 left without a decay path. Thirty
   * minutes because an unanswered approval is worth keeping on screen for a
   * long lunch, but not forever.
   */
  APPROVAL_DECAY: 1_800_000,
  /**
   * The "agent is busy" states. A build or a test run can legitimately take
   * minutes, so this is generous — it exists to catch a hook that never
   * arrived, not to interrupt real work.
   */
  ACTIVITY_DECAY: 300_000,
  /** I4: nothing survives five silent minutes — except the attention states. */
  WATCHDOG: 300_000,
} as const;

/** ≥1 tool, ≥15 s, nothing broke. Answering a question is not an achievement. */
export const CELEBRATION_MIN_TOOLS = 1;
export const CELEBRATION_MIN_MS = 15_000;

const initialContext: PetContext = {
  lastEventAt: 0,
  turnStartedAt: 0,
  toolsThisTurn: 0,
  hadFailureThisTurn: false,
  hopCount: 0,
  blockedReason: null,
};

export function celebrationWorthy(ctx: PetContext, at: number): boolean {
  return (
    ctx.toolsThisTurn >= CELEBRATION_MIN_TOOLS &&
    at - ctx.turnStartedAt >= CELEBRATION_MIN_MS &&
    !ctx.hadFailureThisTurn
  );
}

export const petMachine = setup({
  types: {
    context: {} as PetContext,
    events: {} as PetMachineEvent,
  },
  guards: {
    isBash: ({ event }) => event.type === "TOOL_START" && event.tool === "bash",
    isFileEdit: ({ event }) => event.type === "TOOL_START" && event.tool === "file_edit",
    isReading: ({ event }) =>
      event.type === "TOOL_START" && (event.tool === "file_read" || event.tool === "search"),

    /** A real failure. A cancelled command is not one — Spike B · B3. */
    toolFailed: ({ event }) =>
      event.type === "TOOL_DONE" && !event.ok && event.interrupted !== true,
    toolInterrupted: ({ event }) =>
      event.type === "TOOL_DONE" && !event.ok && event.interrupted === true,

    approvalGranted: ({ event }) => event.type === "APPROVAL_RESOLVED" && event.granted,

    /**
     * D5. `TURN_END` is a fact — the agent stopped talking — not an
     * achievement. Celebrating every turn would hoist a trophy every twenty
     * seconds and teach the user to ignore the trophy.
     */
    worthCelebrating: ({ context, event }) =>
      event.type === "TURN_END" && celebrationWorthy(context, event.at),

    /** Fires only when nothing has arrived for the whole watchdog window. */
    isStale: ({ context, event }) =>
      event.type === "WATCHDOG" && event.at - context.lastEventAt >= DELAYS.WATCHDOG,
  },
  actions: {
    touch: assign({
      lastEventAt: ({ context, event }) => ("at" in event ? event.at : context.lastEventAt),
    }),
    startTurn: assign({
      turnStartedAt: ({ context, event }) => ("at" in event ? event.at : context.turnStartedAt),
      toolsThisTurn: 0,
      hadFailureThisTurn: false,
    }),
    countTool: assign({ toolsThisTurn: ({ context }) => context.toolsThisTurn + 1 }),
    noteFailure: assign({ hadFailureThisTurn: true }),
    hop: assign({ hopCount: ({ context }) => context.hopCount + 1 }),
    recordBlock: assign({
      blockedReason: ({ event }) => (event.type === "AGENT_BLOCKED" ? event.reason : null),
    }),
    clearBlock: assign({ blockedReason: null }),
  },
  delays: DELAYS,
}).createMachine({
  id: "pet",
  initial: "sleeping",
  context: initialContext,

  /**
   * I3 lives here. Anything that can happen at any moment is handled once, at
   * the root, so a state cannot swallow it by omission. Child states may
   * override a specific event, and two of them do — deliberately.
   */
  on: {
    "*": { actions: "touch" },

    SESSION_START: { target: ".idle", actions: ["touch", "clearBlock"] },
    SESSION_END: { target: ".sleeping", actions: "touch" },
    AGENT_IDLE: { target: ".idle", actions: "touch" },
    PROMPT_SUBMITTED: { target: ".attentive", actions: ["touch", "startTurn", "clearBlock"] },
    APPROVAL_NEEDED: { target: ".waiting_approval", actions: "touch" },
    AGENT_BLOCKED: { target: ".exhausted", actions: ["touch", "recordBlock"] },

    TOOL_START: [
      {
        guard: "isBash",
        target: ".working.digging",
        actions: ["touch", "countTool", "clearBlock"],
      },
      {
        guard: "isFileEdit",
        target: ".working.typing",
        actions: ["touch", "countTool", "clearBlock"],
      },
      {
        guard: "isReading",
        target: ".working.reading",
        actions: ["touch", "countTool", "clearBlock"],
      },
      { target: ".working.generic", actions: ["touch", "countTool", "clearBlock"] },
    ],

    TURN_END: [
      { guard: "worthCelebrating", target: ".celebrating", actions: "touch" },
      { target: ".idle", actions: "touch" },
    ],

    WATCHDOG: { guard: "isStale", target: ".sleeping", actions: "touch" },
  },

  states: {
    sleeping: {},

    idle: {
      after: { IDLE_TO_SLEEP: "sleeping" },
    },

    attentive: {
      // I4 requires a decay path *in addition to* the watchdog. Without this,
      // a prompt that never produces a tool call and never ends leaves the pet
      // permanently attentive whenever the host's watchdog timer is not
      // running — which the "no state is terminal" test proved.
      after: { ACTIVITY_DECAY: "idle" },
    },

    working: {
      initial: "generic",
      // Same reasoning as `attentive`. Sits on the parent so that moving
      // between substates does not reset the clock on a stalled tool call.
      after: { ACTIVITY_DECAY: "idle" },
      on: {
        TOOL_DONE: [
          { guard: "toolFailed", target: "#pet.error", actions: ["touch", "noteFailure"] },
          // A cancelled command is not a failure to show. The agent has stopped
          // either way, so idle is the honest state.
          { guard: "toolInterrupted", target: "#pet.idle", actions: "touch" },
          // Success: stay put and let the renderer play a one-shot hop, so a
          // long sequence of tool calls reads as continuous work.
          { actions: ["touch", "hop"] },
        ],
      },
      states: {
        digging: {},
        typing: {},
        reading: {},
        generic: {},
      },
    },

    waiting_approval: {
      // The watchdog deliberately does not clear this state; see the note on
      // APPROVAL_DECAY. Silence here means the user stepped away, which is
      // exactly when the request most needs to still be on screen.
      on: {
        WATCHDOG: {},
        APPROVAL_RESOLVED: [
          { guard: "approvalGranted", target: "working.generic", actions: "touch" },
          { target: "idle", actions: "touch" },
        ],
      },
      after: { APPROVAL_DECAY: "idle" },
    },

    error: {
      after: { ERROR_DECAY: "idle" },
    },

    exhausted: {
      // Same reasoning as waiting_approval: the agent is stuck and the user has
      // to act, so no events is the expected condition, not a wedged pet.
      on: { WATCHDOG: {} },
      after: { EXHAUSTED_DECAY: { target: "idle", actions: "clearBlock" } },
    },

    celebrating: {
      after: { CELEBRATION: "idle" },
    },
  },
});

/** Flatten xstate's nested value into the `PetState` the renderer speaks. */
export function toPetState(value: unknown): PetState {
  if (typeof value === "string") return value as PetState;
  if (value && typeof value === "object") {
    const [parent, child] = Object.entries(value as Record<string, unknown>)[0] ?? [];
    if (parent && typeof child === "string") return `${parent}.${child}` as PetState;
  }
  return "idle";
}
