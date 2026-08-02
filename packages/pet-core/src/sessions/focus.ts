/**
 * Which of several concurrent agent sessions the single pet is showing.
 *
 * Spec §8.2. This was the largest gap in spec v1, which assumed one pet to one
 * session. Real users run three to five at once and every one of them posts to
 * the same port; without a policy the pet thrashes between them, and M2 would
 * pass on a single-session demo while failing on an actual workday.
 *
 * Kept as a pure function over plain data so the ordering can be tested without
 * a registry, actors or a clock.
 */

import type { ToolKind } from "@agent-pet/protocol";
import type { PetState } from "../packs/stateMap.ts";

/** States in which the pet is asking the user for something. */
export const ATTENTION_STATES: ReadonlySet<PetState> = new Set<PetState>([
  "waiting_approval",
  // The agent asked a question. Same claim on the user as an approval, and the
  // same reason to outrank a chatty background session.
  "waiting_input",
  "exhausted",
]);

export function needsAttention(state: PetState): boolean {
  return ATTENTION_STATES.has(state);
}

export interface SessionView {
  readonly sessionId: string;
  readonly source: string;
  /** basename of the session's cwd, when the adapter supplied one. */
  readonly project?: string;
  readonly state: PetState;
  readonly lastEventAt: number;
  /** When this session entered its current attention state, if it is in one. */
  readonly attentionSince?: number;
  readonly blockedReason: string | null;
  /** The kind of work in flight, when there is any. Drives the bubble. */
  readonly activity: ToolKind | null;
  /** What that work is on — a filename, a command, a search term. */
  readonly activityLabel: string | null;
}

/**
 * Pick the session to render.
 *
 *   1. the session that has been waiting on the user longest
 *   2. otherwise the most recently active session
 *   3. otherwise nothing
 *
 * Attention outranks recency deliberately, and it is the whole point of the
 * policy. An unanswered approval is the only state where the pet is asking for
 * something; letting a chatty background session bury it would defeat the
 * purpose of having a pet at all.
 *
 * Ties break on `sessionId` so the choice is stable rather than dependent on
 * map insertion order — a pet that flickers between two equally-recent
 * sessions is worse than one that picks arbitrarily but sticks with it.
 */
export function pickFocus(sessions: readonly SessionView[]): SessionView | null {
  if (sessions.length === 0) return null;

  const waiting = sessions.filter((s) => needsAttention(s.state));
  if (waiting.length > 0) {
    return [...waiting].sort(
      (a, b) =>
        (a.attentionSince ?? a.lastEventAt) - (b.attentionSince ?? b.lastEventAt) ||
        a.sessionId.localeCompare(b.sessionId),
    )[0] as SessionView;
  }

  return [...sessions].sort(
    (a, b) => b.lastEventAt - a.lastEventAt || a.sessionId.localeCompare(b.sessionId),
  )[0] as SessionView;
}

/**
 * The project name to show, or nothing.
 *
 * With one session the project name is noise — the user knows what they are
 * running. With several it is the only way to tell which one the pet means, so
 * it appears exactly then.
 */
export function focusLabel(focused: SessionView | null, liveCount: number): string | undefined {
  if (!focused || liveCount <= 1) return undefined;
  return focused.project;
}
