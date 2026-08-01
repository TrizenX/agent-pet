import { type PetState, STATE_GLYPHS } from "../packs/stateMap.ts";

/**
 * The instrument, drawn over the toy.
 *
 * Spike D · F5 measured why this layer exists: across a 4 289-pet gallery, row
 * 7 is a laptop on one pet, a blink on another and nothing at all on a third.
 * Body animation cannot carry state when the body is someone else's art. The
 * glyph is the only part of the render we control on every pet, so it is what
 * keeps §1.1's 200 ms glance test alive.
 */
export function StateGlyph({
  state,
  enabled,
  reducedMotion,
}: {
  readonly state: PetState;
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
}) {
  const glyph = STATE_GLYPHS[state];
  if (!enabled || !glyph) return null;

  return (
    <div
      className="pet-glyph"
      data-glow={reducedMotion && glyph.glow.endsWith("pulse") ? "none" : glyph.glow}
      role="status"
      aria-label={glyph.id}
    >
      {glyph.emoji}
    </div>
  );
}
