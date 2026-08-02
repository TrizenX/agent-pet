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
 * **I6 — idle cost is zero.** The watchdog holds no clock: staleness is read
 * from the `at` field every event already carries, so the host decides when to
 * check and nothing ticks while the pet is asleep. The per-state decays are
 * xstate `after:` transitions and *do* use real timers, which is why their
 * tests fake the clock — worth knowing before assuming this file is
 * timer-free.
 */

import type { PetEvent, ToolKind } from "@agent-pet/protocol";
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
  /**
   * What kind of work is in flight, so the pet can say so.
   *
   * The `ToolKind` from the wire, never the adapter's `label`. `label` would
   * carry agent-specific text into pet-core at runtime, where the I5 lint
   * cannot see it — the rule would still be enforced and still be broken.
   */
  activity: ToolKind | null;
  /**
   * What the work is *on* — a filename, a command's description, a search term.
   *
   * Supplied by the adapter, never composed here. This is data crossing the
   * wire, not knowledge living in the source, which is the distinction I5 draws
   * and the one an earlier version of this file got wrong: it refused the field
   * on I5 grounds and left the pet saying "Working…" while you watched it work.
   */
  activityLabel: string | null;
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
  activity: null,
  activityLabel: null,
};

export function celebrationWorthy(ctx: PetContext, at: number): boolean {
  return (
    ctx.toolsThisTurn >= CELEBRATION_MIN_TOOLS &&
    // A turn we never saw begin is a turn whose length we do not know.
    //
    // `turnStartedAt` is only set by `PROMPT_SUBMITTED`, and it starts at zero.
    // So for any adapter that has no notion of a prompt, `at - 0` is the whole
    // epoch and the duration test passed unconditionally — every single turn
    // earned a trophy. Found the moment a second adapter existed: `git commit`
    // celebrated, and would have celebrated every commit forever, which is
    // exactly the training-to-ignore-it failure D5 exists to prevent.
    //
    // The guard silently assumed an event only one agent happens to send.
    ctx.turnStartedAt > 0 &&
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
    isDelegate: ({ event }) => event.type === "TOOL_START" && event.tool === "delegate",
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
    recordActivity: assign({
      activity: ({ event }) => (event.type === "TOOL_START" ? event.tool : null),
      activityLabel: ({ event }) => (event.type === "TOOL_START" ? (event.label ?? null) : null),
    }),
    /**
     * Cleared when the work ends rather than when the next starts. A pet that
     * keeps saying "Running…" after the command finished is worse than one that
     * says nothing: the first is wrong, the second is merely quiet.
     */
    clearActivity: assign({ activity: null, activityLabel: null }),
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

    SESSION_START: { target: ".idle", actions: ["touch", "clearBlock", "clearActivity"] },
    SESSION_END: { target: ".sleeping", actions: ["touch", "clearActivity"] },
    AGENT_IDLE: { target: ".idle", actions: ["touch", "clearActivity"] },
    PROMPT_SUBMITTED: {
      target: ".attentive",
      actions: ["touch", "startTurn", "clearBlock", "clearActivity"],
    },
    // Clears the activity too. The bubble would not show it here anyway —
    // an approval outranks the tool that triggered it — but holding the rule
    // in the context rather than only in the view means there is one place it
    // can be wrong instead of two.
    APPROVAL_NEEDED: { target: ".waiting_approval", actions: ["touch", "clearActivity"] },
    AGENT_BLOCKED: { target: ".exhausted", actions: ["touch", "recordBlock", "clearActivity"] },
    INPUT_NEEDED: { target: ".waiting_input", actions: ["touch", "clearActivity"] },
    COMPACTING: { target: ".compacting", actions: ["touch", "clearActivity"] },
    /**
     * A delegated agent, both ends.
     *
     * `SUBAGENT_START` sat unhandled here until the M5 review established that
     * `SubagentStart` is a real hook — the comment that used to be on this
     * transition claimed no start hook existed, which was simply wrong, and the
     * pet was inferring delegation from a tool name instead of being told.
     *
     * `SUBAGENT_END` landing in `working.generic` is right for the case it was
     * sent for and harmless elsewhere: whatever the agent does next sends its
     * own event.
     */
    SUBAGENT_START: {
      target: ".working.delegating",
      actions: ["touch", "clearBlock", "clearActivity"],
    },
    SUBAGENT_END: { target: ".working.generic", actions: ["touch", "clearActivity"] },
    /**
     * Compaction finished. Without this the state unwound on a five-minute
     * decay, which is a guess wearing the clothes of a fact.
     */
    COMPACTED: { target: ".idle", actions: ["touch", "clearActivity"] },

    TOOL_START: [
      {
        guard: "isBash",
        target: ".working.digging",
        actions: ["touch", "countTool", "clearBlock", "recordActivity"],
      },
      {
        guard: "isFileEdit",
        target: ".working.typing",
        actions: ["touch", "countTool", "clearBlock", "recordActivity"],
      },
      {
        guard: "isDelegate",
        target: ".working.delegating",
        actions: ["touch", "countTool", "clearBlock", "recordActivity"],
      },
      {
        guard: "isReading",
        target: ".working.reading",
        actions: ["touch", "countTool", "clearBlock", "recordActivity"],
      },
      {
        target: ".working.generic",
        actions: ["touch", "countTool", "clearBlock", "recordActivity"],
      },
    ],

    TURN_END: [
      {
        guard: "worthCelebrating",
        target: ".celebrating",
        actions: ["touch", "clearActivity"],
      },
      { target: ".idle", actions: ["touch", "clearActivity"] },
    ],

    /**
     * A tool finished, from wherever the pet happens to be.
     *
     * `working` has its own, narrower handler below — stay put and hop — and a
     * descendant's handler wins, so ordinary tool sequences are unaffected.
     * This is the case where the pet is somewhere else entirely, and the only
     * one that matters is `waiting_approval`.
     *
     * Granting permission produces no event of its own. A denial arrives as
     * `APPROVAL_RESOLVED`; an approval arrives as nothing at all, and the next
     * thing the pet hears is the finished tool. So without this it went on
     * saying "May I?" after the user had already said yes — until the next tool
     * call or the thirty-minute decay, whichever came first. Reported exactly
     * that way.
     *
     * It was also an I3 violation in plain sight: `waiting_approval` was
     * swallowing an incoming event, which §2 says no state may do.
     */
    TOOL_DONE: [
      {
        guard: "toolFailed",
        target: ".error",
        actions: ["touch", "noteFailure", "clearActivity"],
      },
      { guard: "toolInterrupted", target: ".idle", actions: ["touch", "clearActivity"] },
      { target: ".working.generic", actions: ["touch", "hop", "clearActivity"] },
    ],

    WATCHDOG: { guard: "isStale", target: ".sleeping", actions: ["touch", "clearActivity"] },
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
      //
      // Clears the activity, like every other exit from work. This one was
      // missed twice over — it is the third instance of the same bug in this
      // milestone — and it is the worst place to miss it: this path exists
      // precisely for a hook that never arrived, which is exactly when a stale
      // "Crunching…" is most likely to be on screen and most likely to be a lie.
      after: { ACTIVITY_DECAY: { target: "idle", actions: "clearActivity" } },
      on: {
        TOOL_DONE: [
          {
            guard: "toolFailed",
            target: "#pet.error",
            actions: ["touch", "noteFailure", "clearActivity"],
          },
          // A cancelled command is not a failure to show. The agent has stopped
          // either way, so idle is the honest state.
          { guard: "toolInterrupted", target: "#pet.idle", actions: ["touch", "clearActivity"] },
          // Success: stay put and let the renderer play a one-shot hop, so a
          // long sequence of tool calls reads as continuous work.
          //
          // The activity clears even though the state does not. Between two
          // tool calls the agent is working but not running anything, and the
          // pet falling back to a general word is honest where naming the
          // command that already finished would not be.
          { actions: ["touch", "hop", "clearActivity"] },
        ],
      },
      states: {
        digging: {},
        typing: {},
        reading: {},
        delegating: {},
        generic: {},
      },
    },

    /**
     * The agent asked a question. An attention state, so the watchdog leaves it
     * alone for the same reason it leaves an approval alone — silence here
     * means the user stepped away, which is when the question most needs to
     * still be on screen.
     */
    waiting_input: {
      on: { WATCHDOG: {} },
      after: { APPROVAL_DECAY: "idle" },
    },

    /**
     * Compaction. Bounded by the same generous decay as the other busy states:
     * it can legitimately take a while, and the decay is there to catch a hook
     * that never arrived rather than to interrupt real work.
     */
    compacting: {
      after: { ACTIVITY_DECAY: "idle" },
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
