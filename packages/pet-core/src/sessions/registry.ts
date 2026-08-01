/**
 * One machine actor per live agent session.
 *
 * Spec §8. Events arrive interleaved from every session on the machine, so each
 * one needs its own state; the pet then renders whichever the focus policy
 * picks. Without this, a `waiting_approval` in one project is overwritten a
 * moment later by a tool call in another and the user never sees the request.
 *
 * The registry owns no clock. `tick(now)` is called by the host, which keeps
 * eviction and the watchdog deterministic in tests and means nothing spins
 * while the pet is asleep (I6).
 */

import type { PetEvent } from "@agent-pet/protocol";
import { type Actor, createActor } from "xstate";
import { type PetMachineEvent, petMachine, toPetState } from "../machine/petMachine.ts";
import type { PetState } from "../packs/stateMap.ts";
import { focusLabel, needsAttention, pickFocus, type SessionView } from "./focus.ts";

/**
 * How long a silent session is kept.
 *
 * This is what keeps memory flat across a workday — M2's soak criterion. A
 * session in an attention state is never evicted while it is asking for
 * something; it does not need a second, longer constant, because the machine
 * decays `waiting_approval` and `exhausted` on its own, after which the normal
 * rule applies immediately.
 */
export const EVICT_AFTER_MS = 600_000;

interface Session {
  readonly sessionId: string;
  readonly source: string;
  project?: string;
  actor: Actor<typeof petMachine>;
  lastEventAt: number;
  state: PetState;
  attentionSince: number | undefined;
}

export interface RegistrySnapshot {
  readonly focused: SessionView | null;
  /** Shown next to the pet when more than one session is live. */
  readonly label: string | undefined;
  readonly liveCount: number;
  readonly sessions: readonly SessionView[];
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  /** Route an event to its own session, creating one if this is the first. */
  handle(event: PetEvent): void {
    const session = this.sessions.get(event.sessionId) ?? this.create(event);
    if (event.project) session.project = event.project;
    this.send(session, event, event.at);
  }

  /**
   * Advance time: run the watchdog on every session and evict the silent ones.
   *
   * Returns the ids evicted, mostly so tests and the event log can say what
   * happened rather than inferring it from a shrinking map.
   */
  tick(now: number): string[] {
    for (const session of this.sessions.values()) {
      this.send(session, { type: "WATCHDOG", at: now }, now);
    }

    const evicted: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastEventAt < EVICT_AFTER_MS) continue;
      // Never drop a session while it is still asking the user for something.
      // The machine's own decay guarantees it leaves that state eventually, so
      // this cannot leak.
      if (needsAttention(session.state)) continue;

      // Synthesised rather than real: the agent is gone and will not send one.
      // Sending it before stopping keeps the actor's own bookkeeping honest.
      session.actor.send({ ...SYNTHETIC_END, at: now, sessionId: id });
      session.actor.stop();
      this.sessions.delete(id);
      evicted.push(id);
    }
    return evicted;
  }

  snapshot(): RegistrySnapshot {
    const views = [...this.sessions.values()].map(toView);
    const focused = pickFocus(views);
    return {
      focused,
      label: focusLabel(focused, views.length),
      liveCount: views.length,
      sessions: views,
    };
  }

  /** What the pet should currently be drawing. */
  focusedState(): PetState {
    return this.snapshot().focused?.state ?? "sleeping";
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Stop every actor. Called on shutdown so no timer outlives the app. */
  clear(): void {
    for (const session of this.sessions.values()) session.actor.stop();
    this.sessions.clear();
  }

  private create(event: PetEvent): Session {
    const actor = createActor(petMachine).start();
    const session: Session = {
      sessionId: event.sessionId,
      source: event.source,
      actor,
      lastEventAt: event.at,
      state: toPetState(actor.getSnapshot().value),
      attentionSince: undefined,
    };
    this.sessions.set(event.sessionId, session);
    return session;
  }

  private send(session: Session, event: PetMachineEvent, at: number): void {
    const before = session.state;
    session.actor.send(event);
    const after = toPetState(session.actor.getSnapshot().value);

    session.state = after;
    if (event.type !== "WATCHDOG") session.lastEventAt = at;

    // Stamped on entry, not refreshed while the state persists — the focus
    // policy needs "who has been waiting longest", not "who most recently
    // still was".
    if (needsAttention(after)) {
      if (!needsAttention(before) || session.attentionSince === undefined) {
        session.attentionSince = at;
      }
    } else {
      session.attentionSince = undefined;
    }
  }
}

const SYNTHETIC_END = {
  v: 1,
  source: "registry",
  type: "SESSION_END",
} as const;

function toView(session: Session): SessionView {
  return {
    sessionId: session.sessionId,
    source: session.source,
    ...(session.project === undefined ? {} : { project: session.project }),
    state: session.state,
    lastEventAt: session.lastEventAt,
    ...(session.attentionSince === undefined ? {} : { attentionSince: session.attentionSince }),
    blockedReason: session.actor.getSnapshot().context.blockedReason,
  };
}
