import { describe, expect, it } from "vitest";
import { ATLAS_ROWS } from "./atlas.ts";
import {
  type PetState,
  REQUIRED_ROWS,
  rowIndexForState,
  STATE_ANIMATIONS,
  STATE_GLYPHS,
} from "./stateMap.ts";

const ALL_STATES = Object.keys(STATE_ANIMATIONS) as PetState[];

describe("state -> row mapping", () => {
  it("covers all eleven states", () => {
    expect(ALL_STATES).toHaveLength(11);
  });

  it("resolves every state to a row that exists in the atlas", () => {
    for (const state of ALL_STATES) {
      const idx = rowIndexForState(state);
      expect(idx, state).toBeGreaterThanOrEqual(0);
      expect(idx, state).toBeLessThan(ATLAS_ROWS.length);
    }
  });

  it("applies the Spike D · F6 correction", () => {
    // Authors draw row 7 as working-at-a-laptop, so typing belongs there and
    // digging takes the genuine motion cycle on row 1.
    expect(STATE_ANIMATIONS["working.typing"].row).toBe("running");
    expect(STATE_ANIMATIONS["working.digging"].row).toBe("running-right");
  });

  it("keeps sleeping fully static — invariant I6", () => {
    const s = STATE_ANIMATIONS.sleeping;
    expect(s.mode).toBe("static");
    expect(s.fpsScale).toBe(0);
  });

  it("names a follow-up state for every once-then animation", () => {
    for (const [state, anim] of Object.entries(STATE_ANIMATIONS)) {
      if (anim.mode === "once-then") expect(anim.nextState, state).toBeDefined();
    }
  });

  it("lists required rows without duplicates", () => {
    expect(new Set(REQUIRED_ROWS).size).toBe(REQUIRED_ROWS.length);
    for (const row of REQUIRED_ROWS) expect(ATLAS_ROWS).toContain(row);
  });
});

describe("glyph layer (§9.5)", () => {
  it("disambiguates the states that share atlas row `failed`", () => {
    expect(STATE_ANIMATIONS.error.row).toBe(STATE_ANIMATIONS.exhausted.row);
    // Sharing a row is only acceptable because the glyphs differ.
    expect(STATE_GLYPHS.error?.id).not.toBe(STATE_GLYPHS.exhausted?.id);
  });

  it("marks every state that demands user attention", () => {
    for (const state of ["waiting_approval", "exhausted", "error"] as const) {
      expect(STATE_GLYPHS[state], state).toBeDefined();
    }
  });

  it("leaves ordinary working states unmarked", () => {
    for (const state of ["idle", "working.typing", "working.digging", "sleeping"] as const) {
      expect(STATE_GLYPHS[state], state).toBeUndefined();
    }
  });
});
