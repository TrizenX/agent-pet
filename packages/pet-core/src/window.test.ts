import { readFileSync } from "node:fs";
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

describe("the bubble is allowed to use the room it has", () => {
  const css = readFileSync(new URL("./styles/pet.css", import.meta.url), "utf8");
  const rule = (selector: string) =>
    css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));

  /**
   * Asserted against the stylesheet, not the DOM.
   *
   * jsdom does no layout, so a rendering test cannot tell a truncated line from
   * a whole one — `textContent` is the same either way. Reading the rule is
   * crude, and it is the only check here that can actually fail.
   */
  it("does not cap the project name", () => {
    // Capped at 38%, "agent-pet" rendered as "agent-p…", which defeats naming
    // the session at all. If a line has to give, it is the description.
    expect(rule(".pet-bubble-project")).not.toContain("max-width");
  });

  it("sizes the bubble to its content before capping it", () => {
    // With `left: 50%` and `right: auto` the available width is only the half
    // of the window right of centre, so the bubble shrank to 210px and
    // ellipsised a line with 412px to live in.
    expect(rule(".pet-bubble")).toContain("width: max-content");
  });
});

describe("the pet is composited at all", () => {
  const css = readFileSync(new URL("./styles/pet.css", import.meta.url), "utf8");

  /**
   * TZX-97, and the most expensive lesson in the project so far.
   *
   * A fully transparent page makes WKWebView composite none of the layer, so
   * the pet was invisible on screen while `/health` reported a connected
   * webview, the state machine ran correctly, and the frontend logged a laid-out
   * speech bubble. Every instrument that looks at the *window* said it was fine,
   * because it was fine. Six hypotheses died before anyone gave the root a
   * colour and watched the penguin appear.
   *
   * Measured by capturing the window by id: `transparent` gives alpha extrema
   * (0, 0) — not one painted pixel; `rgba(0,0,0,0.01)` gives (3, 255).
   *
   * jsdom composites nothing, so this cannot be a rendering test. Reading the
   * rule is crude and it is the only check here that can fail — which is the
   * whole point, because the fix looks exactly like a stray debug style someone
   * would tidy away.
   */
  // Comments stripped first, and that is not fussiness. The rule this guards is
  // explained by a comment that *contains* `background: rgba(0,0,0,0.01)` as
  // example text, so the first version of this test matched the explanation
  // instead of the declaration and passed happily with the real one deleted.
  // A test whose own documentation satisfies it is worse than no test.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = bare.slice(
    bare.indexOf(".pet-root {"),
    bare.indexOf("}", bare.indexOf(".pet-root {")),
  );

  it("gives the root a background, or nothing renders", () => {
    const match = rule.match(/background:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
    expect(match, ".pet-root has no rgba background — see TZX-97").not.toBeNull();
    const alpha = Number(match?.[1]);
    // Above zero or the layer is dropped; low enough that the user is not
    // looking through a tinted rectangle all day (§9.1).
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThanOrEqual(0.02);
  });

  it("keeps the window itself transparent — the workaround is in the page", () => {
    // If someone "fixes" this by making the window opaque, the pet becomes a
    // grey box over the editor, which is worse than the bug.
    expect(config.app.windows[0]?.transparent).toBe(true);
  });
});
