// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH, ROW_INDEX } from "../packs/atlas.ts";
import { buildPack, type LoadedPack } from "../packs/loader.ts";
import type { PetState } from "../packs/stateMap.ts";
import { Pet } from "./Pet.tsx";
import { SessionBadge } from "./SessionBadge.tsx";
import { SpeechBubble } from "./SpeechBubble.tsx";
import { StateGlyph } from "./StateGlyph.tsx";

function sheet(counts: readonly number[]): ImageData {
  const width = FRAME_WIDTH * COLUMNS;
  const height = FRAME_HEIGHT * 9;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < (counts[row] ?? 0); col++) {
      for (let y = 0; y < FRAME_HEIGHT; y++) {
        const py = row * FRAME_HEIGHT + y;
        for (let x = 0; x < FRAME_WIDTH; x++) {
          data[(py * width + col * FRAME_WIDTH + x) * 4 + 3] = 255;
        }
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

const MODAL = [6, 8, 8, 4, 5, 8, 6, 6, 6];
function packWith(counts: readonly number[] = MODAL): LoadedPack {
  const r = buildPack(
    { id: "t", displayName: "T", spritesheetPath: "s.png" },
    sheet(counts),
    "asset://s.png",
  );
  if (!r.ok) throw new Error("fixture pack failed to build");
  return r.pack;
}

const sprite = () => document.querySelector(".pet-sprite") as HTMLElement;
const draw = (state: PetState, opts: { reduced?: boolean; pack?: LoadedPack } = {}) =>
  render(
    <Pet
      pack={opts.pack ?? packWith()}
      state={state}
      scale={1}
      reducedMotion={opts.reduced ?? false}
    />,
  );

// Auto-cleanup only registers when vitest runs with globals; without this every
// render stacks up in the same document and `querySelector` keeps returning the
// first one, which makes each test silently assert about its predecessor.
afterEach(() => {
  cleanup();
  document.getElementById("pet-step-keyframes")?.remove();
});

describe("Pet", () => {
  it("samples the row stateMap points at", () => {
    draw("waiting_approval");
    expect(sprite().style.backgroundPositionY).toBe(`${-ROW_INDEX.waving * FRAME_HEIGHT}px`);
  });

  it("animates with as many steps as the sheet actually has frames", () => {
    draw("waiting_approval"); // waving row: 4 frames
    expect(sprite().style.animation).toContain("steps(4)");
    expect(sprite().style.animation).toContain("pet-step-4");
  });

  it("holds a single frame while sleeping — I6 wants no animation, not a slow one", () => {
    draw("sleeping");
    expect(sprite().style.animation).toBe("none");
  });

  it("holds a single frame under prefers-reduced-motion", () => {
    draw("working.digging", { reduced: true });
    expect(sprite().style.animation).toBe("none");
  });

  it("plays a one-shot state once and keeps the last frame", () => {
    draw("error");
    expect(sprite().style.animation).toContain("1 normal forwards");
    expect(sprite().style.animation).not.toContain("infinite");
  });

  it("mirrors the left-facing run when the pack only drew one direction", () => {
    const counts = [...MODAL];
    counts[ROW_INDEX["running-left"]] = 0;
    // No state maps to running-left yet, so drive the resolver through the pack.
    const pack = packWith(counts);
    expect(pack.mirrorRunningLeft).toBe(true);
  });

  it("marks a substituted row so a broken pack is visible in the DOM", () => {
    const counts = [...MODAL];
    counts[ROW_INDEX.review] = 0;
    draw("working.reading", { pack: packWith(counts) });
    expect(sprite().dataset.substituted).toBe("true");
    expect(sprite().style.backgroundPositionY).toBe(`${-ROW_INDEX.idle * FRAME_HEIGHT}px`);
  });

  it("remounts on a state change so the animation restarts (I3, §7.4)", () => {
    const pack = packWith();
    const { rerender } = render(<Pet pack={pack} state="idle" scale={1} reducedMotion={false} />);
    const before = sprite();
    rerender(<Pet pack={pack} state="working.digging" scale={1} reducedMotion={false} />);
    // A CSS animation does not restart on its own; only a new element does.
    expect(sprite()).not.toBe(before);
  });

  it("scales by whole pixels so the art stays crisp", () => {
    render(<Pet pack={packWith()} state="idle" scale={2} reducedMotion={false} />);
    expect(sprite().style.width).toBe(`${FRAME_WIDTH * 2}px`);
    expect(sprite().style.backgroundSize).toBe(
      `${FRAME_WIDTH * 2 * COLUMNS}px ${FRAME_HEIGHT * 2 * 9}px`,
    );
  });
});

describe("StateGlyph", () => {
  it("marks the states that need the user", () => {
    for (const state of ["waiting_approval", "exhausted", "error", "celebrating"] as PetState[]) {
      const { unmount } = render(<StateGlyph state={state} enabled reducedMotion={false} />);
      expect(document.querySelector(".pet-glyph"), state).not.toBeNull();
      unmount();
    }
  });

  it("stays out of the way for ordinary work", () => {
    for (const state of ["idle", "working.typing", "sleeping"] as PetState[]) {
      const { unmount } = render(<StateGlyph state={state} enabled reducedMotion={false} />);
      expect(document.querySelector(".pet-glyph"), state).toBeNull();
      unmount();
    }
  });

  it("can be switched off from the tray", () => {
    render(<StateGlyph state="waiting_approval" enabled={false} reducedMotion={false} />);
    expect(document.querySelector(".pet-glyph")).toBeNull();
  });

  it("stops pulsing under prefers-reduced-motion", () => {
    render(<StateGlyph state="waiting_approval" enabled reducedMotion />);
    expect(document.querySelector(".pet-glyph")?.getAttribute("data-glow")).toBe("none");
  });

  it("distinguishes error from exhausted, which share an atlas row", () => {
    const { unmount } = render(<StateGlyph state="error" enabled reducedMotion={false} />);
    const errorGlyph = document.querySelector(".pet-glyph")?.textContent;
    unmount();
    render(<StateGlyph state="exhausted" enabled reducedMotion={false} />);
    expect(document.querySelector(".pet-glyph")?.textContent).not.toBe(errorGlyph);
  });
});

describe("SpeechBubble", () => {
  it("says something for the states that need the user", () => {
    render(<SpeechBubble state="waiting_approval" />);
    expect(screen.getByText(/may i/i)).toBeTruthy();
  });

  it("names what the work is on, not just what kind it is", () => {
    // The whole point, and the thing the first version got wrong: "Running…"
    // tells you nothing you could not already see. "Running pnpm test" does.
    const { unmount } = render(
      <SpeechBubble state="working.digging" activity="bash" activityLabel="pnpm test" />,
    );
    expect(screen.getByText("Running pnpm test")).toBeTruthy();
    unmount();

    render(<SpeechBubble state="working.typing" activity="file_edit" activityLabel="mapping.ts" />);
    expect(screen.getByText("Editing mapping.ts")).toBeTruthy();
  });

  it("falls back to the bare verb when the adapter sent no label", () => {
    render(<SpeechBubble state="working.digging" activity="bash" />);
    expect(screen.getByText("Running…")).toBeTruthy();
  });

  it("says it is thinking in the gap between two tool calls", () => {
    // The machine clears the activity when a tool finishes, so this is the real
    // gap between calls — and in that gap the model is deciding what to do
    // next. It used to say "On it!", which answers nothing.
    render(<SpeechBubble state="working.generic" activity={null} />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("puts the user's request ahead of whatever tool caused it", () => {
    render(<SpeechBubble state="waiting_approval" activity="bash" />);
    expect(screen.getByText(/may i/i)).toBeTruthy();
    expect(document.querySelector(".pet-bubble")?.textContent).not.toMatch(/running/i);
  });

  it("lets a pack override win, even mid-tool", () => {
    render(
      <SpeechBubble
        state="working.digging"
        activity="bash"
        overrides={{ "working.digging": "ribbit" }}
      />,
    );
    expect(screen.getByText("ribbit")).toBeTruthy();
  });

  it("names the project when one was supplied", () => {
    render(<SpeechBubble state="waiting_approval" project="acme-api" />);
    expect(screen.getByText("acme-api")).toBeTruthy();
  });

  it("speaks Vietnamese when asked", () => {
    const { unmount } = render(<SpeechBubble state="exhausted" locale="vi" />);
    expect(screen.getByText(/Hết pin/)).toBeTruthy();
    unmount();

    render(
      <SpeechBubble state="working.digging" locale="vi" activity="search" activityLabel="TODO" />,
    );
    expect(screen.getByText("Tìm TODO")).toBeTruthy();
  });
});

describe("SessionBadge", () => {
  it("appears only past one session", () => {
    const { unmount } = render(<SessionBadge count={1} />);
    expect(document.querySelector(".pet-badge")).toBeNull();
    unmount();
    render(<SessionBadge count={4} />);
    expect(screen.getByText("4")).toBeTruthy();
  });
});
