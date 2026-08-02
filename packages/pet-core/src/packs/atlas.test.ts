import { describe, expect, it } from "vitest";
import {
  ATLAS_ROWS,
  COLUMNS,
  classifyGeometry,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  MAX_SCALE,
  MODAL_FRAME_COUNTS_V1,
  measureFrameCounts,
  ROW_INDEX,
  USABLE_ROWS,
} from "./atlas.ts";

/** Builds a synthetic sheet with the given live-frame count per row (Spike D · F2). */
function makeSheet(rows: number, frameCounts: readonly number[], scale = 1): ImageData {
  const fw = FRAME_WIDTH * scale;
  const fh = FRAME_HEIGHT * scale;
  const width = fw * COLUMNS;
  const height = fh * rows;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < rows; row++) {
    const live = frameCounts[row] ?? 0;
    for (let col = 0; col < live; col++) {
      // A solid block is enough: countLiveFrames only reads alpha.
      for (let y = 0; y < fh; y++) {
        const py = row * fh + y;
        for (let x = 0; x < fw; x++) {
          data[(py * width + col * fw + x) * 4 + 3] = 255;
        }
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("row layout (Spike D · F1)", () => {
  it("has nine usable rows in the derived order", () => {
    expect(ATLAS_ROWS).toHaveLength(9);
    expect(USABLE_ROWS).toBe(9);
    expect(ATLAS_ROWS[0]).toBe("idle");
    expect(ATLAS_ROWS[5]).toBe("failed");
    expect(ATLAS_ROWS[8]).toBe("review");
  });

  it("indexes every row exactly once", () => {
    expect(Object.keys(ROW_INDEX)).toHaveLength(9);
    for (const [i, name] of ATLAS_ROWS.entries()) expect(ROW_INDEX[name]).toBe(i);
  });
});

describe("classifyGeometry", () => {
  it("recognises v1 at 1536x1872", () => {
    expect(classifyGeometry(1536, 1872)).toMatchObject({ version: "v1", rows: 9, scale: 1 });
  });

  it("recognises v2 at 1536x2288", () => {
    expect(classifyGeometry(1536, 2288)).toMatchObject({ version: "v2", rows: 11, scale: 1 });
  });

  it("accepts clean integer scales and reports the scaled frame size", () => {
    expect(classifyGeometry(3072, 3744)).toMatchObject({
      version: "v1",
      scale: 2,
      frameWidth: 384,
      frameHeight: 416,
    });
  });

  it("refuses a scale past the decode ceiling", () => {
    // Legal by every other rule, and 2.9 GB of pixels once decoded. Memory is
    // quadratic in scale, so the ceiling has to be here rather than in a
    // caller's judgement.
    expect(classifyGeometry(1536 * MAX_SCALE, 1872 * MAX_SCALE)).toMatchObject({
      scale: MAX_SCALE,
    });
    expect(classifyGeometry(1536 * (MAX_SCALE + 1), 1872 * (MAX_SCALE + 1))).toBeNull();
    expect(classifyGeometry(1536 * 16, 1872 * 16)).toBeNull();
  });

  it.each([
    [1536, 1873],
    [1535, 1872],
    [3072, 1872], // non-uniform scale
    [768, 936], // below 1x
    [0, 0],
  ])("rejects %ix%i by returning null rather than throwing", (w, h) => {
    expect(classifyGeometry(w, h)).toBeNull();
  });
});

describe("measureFrameCounts (Spike D · F2 — counts are per-sheet)", () => {
  const v1 = classifyGeometry(1536, 1872)!;

  it("recovers the modal v1 vector", () => {
    const sheet = makeSheet(9, MODAL_FRAME_COUNTS_V1);
    expect(measureFrameCounts(sheet, v1)).toEqual([...MODAL_FRAME_COUNTS_V1]);
  });

  it("recovers a fully padded sheet like `cactus`", () => {
    const padded = Array<number>(9).fill(8);
    expect(measureFrameCounts(makeSheet(9, padded), v1)).toEqual(padded);
  });

  it("reads only the first nine rows of a v2 sheet", () => {
    const v2 = classifyGeometry(1536, 2288)!;
    const counts = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
    expect(measureFrameCounts(makeSheet(11, counts), v2)).toEqual(counts.slice(0, 9));
  });

  it("reports zero for an empty row instead of failing", () => {
    const counts = [6, 0, 8, 4, 5, 8, 6, 6, 6];
    expect(measureFrameCounts(makeSheet(9, counts), v1)[1]).toBe(0);
  });

  it("works at 2x scale", () => {
    const scaled = classifyGeometry(3072, 3744)!;
    const sheet = makeSheet(9, MODAL_FRAME_COUNTS_V1, 2);
    expect(measureFrameCounts(sheet, scaled)).toEqual([...MODAL_FRAME_COUNTS_V1]);
  });
});
