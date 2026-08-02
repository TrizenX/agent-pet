import { describe, expect, it } from "vitest";
import config from "../src-tauri/tauri.conf.json";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./packs/atlas.ts";

/**
 * The window has to be big enough for the biggest pet *and* the tallest bubble.
 *
 * It was not, and nothing said so. At the largest size the sprite alone was
 * 312 px tall in a 240 px window — the pet itself was clipped and the speech
 * bubble, anchored above its head, had nowhere to exist at all. Reported as
 * text cut off at the top and bottom.
 *
 * Arithmetic rather than a screenshot, because this machine cannot take one:
 * Screen Recording permission is refused, which is recorded in docs/RELEASE.md
 * as an outstanding gap. A number that can fail is the next best thing, and it
 * is strictly better than the log line that convinced me it was fine.
 */

/** The sizes the tray offers. Mirrors `SCALES` in `tray.rs`. */
const MAX_SCALE = 1.5;
/** `MAX_BUBBLE_LINES` rows plus padding, measured at the rendered font size. */
const BUBBLE_MAX_HEIGHT = 90;
/** `.pet-bubble`'s offset above the sprite, from `pet.css`. */
const BUBBLE_GAP = 6;

const win = config.app.windows[0] as { width: number; height: number };

describe("the window fits what it has to draw", () => {
  it("is tall enough for the largest pet and a full bubble above it", () => {
    const needed = FRAME_HEIGHT * MAX_SCALE + BUBBLE_GAP + BUBBLE_MAX_HEIGHT;
    expect(win.height).toBeGreaterThanOrEqual(needed);
  });

  it("is wide enough for the largest pet", () => {
    expect(win.width).toBeGreaterThanOrEqual(FRAME_WIDTH * MAX_SCALE);
  });

  it("leaves room for a line of text rather than a single word", () => {
    // 208 px was narrower than "Running pnpm verify", so the bubble was clipped
    // at the window edge and the pet appeared to only ever say "Running…".
    expect(win.width).toBeGreaterThanOrEqual(360);
  });
});
