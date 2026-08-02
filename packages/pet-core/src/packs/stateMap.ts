/**
 * The only place where our behaviour states meet the atlas's animation rows.
 *
 * Ten states onto nine rows. The deficit is paid for by the glyph layer (§9.5),
 * which Spike D · F5 showed is load-bearing rather than decorative: across a
 * 4 289-pet gallery, body animation alone cannot carry state.
 */

import { type AtlasRow, ROW_INDEX } from "./atlas.ts";

export type PetState =
  | "sleeping"
  | "idle"
  | "attentive"
  | "working.digging"
  | "working.typing"
  | "working.reading"
  | "working.generic"
  | "working.delegating"
  | "compacting"
  | "waiting_input"
  | "waiting_approval"
  | "error"
  | "exhausted"
  | "celebrating";

export type PlaybackMode =
  /** Loop for as long as the state is active. */
  | "loop"
  /** Play once, then hold the final frame until the state changes. */
  | "once-hold"
  /** Render a single frame, no animation at all. Required by I6 when sleeping. */
  | "static";

export interface StateAnimation {
  readonly row: AtlasRow;
  /** Multiplier on the pack's base fps. */
  readonly fpsScale: number;
  readonly mode: PlaybackMode;
  /** Frame index to hold when mode is "static". */
  readonly staticFrame?: number;
}

/**
 * Spike D · F6 corrected two rows relative to spec v2.1:
 *   working.typing  1 running-right -> 7 running
 *       Authors who interpreted row 7 drew it as working at a laptop; `frog`
 *       literally types on one. That is our meaning exactly.
 *   working.digging 7 running -> 1 running-right
 *       Row 1 is a genuine motion cycle on every sheet sampled; it reads as
 *       effort where row 7 may read as nothing at all.
 */
export const STATE_ANIMATIONS: Readonly<Record<PetState, StateAnimation>> = Object.freeze({
  // I6: zero animation while asleep. Not "low fps" — none.
  sleeping: { row: "waiting", fpsScale: 0, mode: "static", staticFrame: 0 },
  idle: { row: "idle", fpsScale: 1, mode: "loop" },
  /**
   * Thinking, which can last a while.
   *
   * Was play-once-and-hold, which froze the pet on the last frame of a jump for
   * as long as the model was reasoning — reported from real use as "the pet
   * just stands still while it thinks". A slow loop reads as alert; a held
   * frame reads as broken. Slower than `celebrating`, which shares this row, so
   * the two are told apart by more than the trophy glyph.
   */
  attentive: { row: "jumping", fpsScale: 0.7, mode: "loop" },
  "working.digging": { row: "running-right", fpsScale: 1, mode: "loop" },
  "working.typing": { row: "running", fpsScale: 1, mode: "loop" },
  "working.reading": { row: "review", fpsScale: 1, mode: "loop" },
  "working.generic": { row: "running", fpsScale: 0.8, mode: "loop" },
  // Slower than the pet's own work: it is supervising, not doing.
  "working.delegating": { row: "running", fpsScale: 0.6, mode: "loop" },
  // Housekeeping. Head down in something, like reading, and unhurried.
  compacting: { row: "review", fpsScale: 0.6, mode: "loop" },
  waiting_approval: { row: "waving", fpsScale: 1, mode: "loop" },
  // Same gesture as an approval — the pet turning to face you. The glyph says
  // which kind of answer it wants.
  waiting_input: { row: "waving", fpsScale: 0.8, mode: "loop" },
  error: { row: "failed", fpsScale: 1, mode: "once-hold" },
  // Shares row 5 with `error`; the glyph and the dwell time separate them.
  exhausted: { row: "failed", fpsScale: 0.4, mode: "once-hold" },
  celebrating: { row: "jumping", fpsScale: 1.2, mode: "loop" },
} satisfies Record<PetState, StateAnimation>);

export function rowIndexForState(state: PetState): number {
  return ROW_INDEX[STATE_ANIMATIONS[state].row];
}

/** Rows any pack must supply for every state to render without fallback. */
export const REQUIRED_ROWS: readonly AtlasRow[] = Object.freeze([
  ...new Set(Object.values(STATE_ANIMATIONS).map((a) => a.row)),
]);

export type GlyphId =
  | "approval"
  | "question"
  | "delegate"
  | "compact"
  | "blocked"
  | "error"
  | "trophy";

export interface GlyphSpec {
  readonly id: GlyphId;
  readonly emoji: string;
  readonly glow: "amber-pulse" | "red-flash" | "red-dim" | "none";
}

/**
 * The overlay layer pet-core draws on top of the pack (§9.5). This is what
 * guarantees the 200 ms glance test survives third-party art (Spike D · F5).
 */
export const STATE_GLYPHS: Readonly<Partial<Record<PetState, GlyphSpec>>> = Object.freeze({
  waiting_approval: { id: "approval", emoji: "❓", glow: "amber-pulse" },
  // Shares row 3 with `waiting_approval`, because both are the pet turning to
  // face the user. The glyph is the whole difference: one wants a yes, the
  // other wants an answer.
  waiting_input: { id: "question", emoji: "💬", glow: "amber-pulse" },
  // Shares row 7 with the other working states. Nothing in the atlas depicts
  // handing work to someone else.
  "working.delegating": { id: "delegate", emoji: "👥", glow: "none" },
  // Shares row 8 with reading, which is close enough — both are the pet with
  // its head down in something.
  compacting: { id: "compact", emoji: "🧹", glow: "none" },
  exhausted: { id: "blocked", emoji: "🔋", glow: "red-dim" },
  error: { id: "error", emoji: "⚠️", glow: "red-flash" },
  celebrating: { id: "trophy", emoji: "🏆", glow: "none" },
});
