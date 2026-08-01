import { PET_EVENT_VERSION, type PetEvent, type PetEventBody } from "@agent-pet/protocol";

/**
 * Scripted event streams, played through the ordinary pipeline.
 *
 * Spec v1 filed demo mode under "distribution notes, not Phase 1 work". That
 * was backwards. It is the fastest development loop, the only deterministic way
 * to exercise multi-session, the marketing GIF generator, and what App Review
 * needs to evaluate the app with no agent installed.
 *
 * Scenarios are data, and the runner sends them through `POST /pet-event` — the
 * same route a third-party integrator would use. A demo that bypassed the
 * pipeline would prove the demo works and nothing else.
 */

export interface Beat {
  /** Milliseconds after the previous beat. */
  readonly after: number;
  readonly sessionId: string;
  readonly project?: string;
  readonly body: PetEventBody;
}

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly beats: readonly Beat[];
}

const s1 = (after: number, body: PetEventBody, project = "acme-api"): Beat => ({
  after,
  sessionId: "demo-1",
  project,
  body,
});

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "full",
    label: "Full session",
    beats: [
      s1(0, { type: "SESSION_START" }),
      s1(700, { type: "PROMPT_SUBMITTED" }),
      s1(1200, { type: "TOOL_START", tool: "file_read" }),
      s1(2600, { type: "TOOL_DONE", ok: true, tool: "file_read" }),
      s1(800, { type: "TOOL_START", tool: "bash" }),
      s1(4200, { type: "TOOL_DONE", ok: true, tool: "bash" }),
      s1(700, { type: "TOOL_START", tool: "file_edit" }),
      s1(3800, { type: "TOOL_DONE", ok: true, tool: "file_edit" }),
      // Sixteen seconds after the prompt, which is what makes this a
      // celebration rather than an ordinary turn end.
      //
      // The scenario is stretched to clear `celebrationWorthy` honestly rather
      // than the threshold being lowered to suit the demo. A demo that showed
      // behaviour the product does not have would mislead exactly the two
      // audiences it exists for: App Review and anyone watching a GIF.
      s1(2000, { type: "TURN_END" }),
      s1(5000, { type: "SESSION_END" }),
    ],
  },
  {
    id: "approval",
    label: "Approval",
    beats: [
      s1(0, { type: "SESSION_START" }),
      s1(600, { type: "PROMPT_SUBMITTED" }),
      s1(700, { type: "TOOL_START", tool: "bash" }),
      s1(1200, { type: "APPROVAL_NEEDED", tool: "bash" }),
      s1(4000, { type: "APPROVAL_RESOLVED", granted: true }),
      s1(2000, { type: "TOOL_DONE", ok: true, tool: "bash" }),
      s1(800, { type: "TURN_END" }),
    ],
  },
  {
    id: "rate-limit",
    label: "Rate limit",
    beats: [
      s1(0, { type: "SESSION_START" }),
      s1(600, { type: "PROMPT_SUBMITTED" }),
      s1(800, { type: "TOOL_START", tool: "bash" }),
      s1(1500, { type: "AGENT_BLOCKED", reason: "rate_limit" }),
      s1(6000, { type: "PROMPT_SUBMITTED" }),
    ],
  },
  {
    id: "error",
    label: "Error",
    beats: [
      s1(0, { type: "SESSION_START" }),
      s1(600, { type: "PROMPT_SUBMITTED" }),
      s1(700, { type: "TOOL_START", tool: "bash" }),
      s1(1400, { type: "TOOL_DONE", ok: false, tool: "bash" }),
      s1(2500, { type: "TOOL_START", tool: "bash" }),
      // Interrupted, not failed: the pet should not fall over (Spike B · B3).
      s1(1500, { type: "TOOL_DONE", ok: false, tool: "bash", interrupted: true }),
    ],
  },
  {
    id: "multi",
    label: "Multi-session",
    beats: [
      s1(0, { type: "SESSION_START" }),
      { after: 300, sessionId: "demo-2", project: "other-repo", body: { type: "SESSION_START" } },
      s1(600, { type: "TOOL_START", tool: "file_edit" }),
      {
        after: 500,
        sessionId: "demo-2",
        project: "other-repo",
        body: { type: "TOOL_START", tool: "bash" },
      },
      // The point of the scenario: session 1 asks for approval, session 2 keeps
      // working, and the pet must stay on session 1.
      s1(900, { type: "APPROVAL_NEEDED", tool: "file_edit" }),
      {
        after: 700,
        sessionId: "demo-2",
        project: "other-repo",
        body: { type: "TOOL_DONE", ok: true, tool: "bash" },
      },
      {
        after: 700,
        sessionId: "demo-2",
        project: "other-repo",
        body: { type: "TOOL_START", tool: "file_read" },
      },
      s1(4000, { type: "APPROVAL_RESOLVED", granted: true }),
    ],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Turn a beat into a wire event. `at` is supplied so the runner owns the clock. */
export function beatToEvent(beat: Beat, at: number): PetEvent {
  return {
    v: PET_EVENT_VERSION,
    source: "demo",
    sessionId: beat.sessionId,
    at,
    ...(beat.project === undefined ? {} : { project: beat.project }),
    ...beat.body,
  };
}

/** Absolute timeline, for tests and for anything that wants to seek. */
export function timeline(scenario: Scenario, start: number): PetEvent[] {
  let t = start;
  return scenario.beats.map((beat) => {
    t += beat.after;
    return beatToEvent(beat, t);
  });
}
