/**
 * Geometry and row layout of the community pet atlas format.
 *
 * This is an art format, not agent knowledge — pet-core deliberately does not
 * record which tool's ecosystem it came from (I5). See docs/ARCHITECTURE.md for
 * provenance.
 *
 * Everything here was derived empirically in M0 Spike D, not copied from a
 * document — upstream publishes row *names* but never row order or frame
 * counts. See artifacts/spike-d/FINDINGS.md and tools/spike-atlas/.
 */

export const FRAME_WIDTH = 192;
export const FRAME_HEIGHT = 208;
export const COLUMNS = 8;

/**
 * Spike D · F1 — verified visually on 5 sheets across both format versions.
 * Order is stable. Index into this array IS the atlas row index.
 */
export const ATLAS_ROWS = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type AtlasRow = (typeof ATLAS_ROWS)[number];

export const ROW_INDEX: Readonly<Record<AtlasRow, number>> = Object.freeze(
  Object.fromEntries(ATLAS_ROWS.map((r, i) => [r, i])) as Record<AtlasRow, number>,
);

export type AtlasVersion = "v1" | "v2";

export interface AtlasGeometry {
  readonly version: AtlasVersion;
  /** Rows physically present in the sheet: 9 for v1, 11 for v2. */
  readonly rows: number;
  /** Integer upscale factor of the sheet relative to the 1536×1872 base. */
  readonly scale: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

const BASE_WIDTH = FRAME_WIDTH * COLUMNS; // 1536
const VERSIONS: ReadonlyArray<{ version: AtlasVersion; rows: number }> = [
  { version: "v1", rows: 9 },
  { version: "v2", rows: 11 },
];

/**
 * The largest upscale we will decode.
 *
 * Not a format rule — upstream has no ceiling — but a resource one, and the
 * absence of it was a real hole. Scale is quadratic in memory: the pixel buffer
 * `measureFrameCounts` needs is `1536·1872·4·s²` bytes, so s=4 is 184 MB and
 * s=16 is 2.9 GB. A sheet at s=16 is *legal* by every other rule here, and
 * counting its frames is a synchronous 735-million-pixel loop on the thread
 * that draws the pet. Four is well past any sheet the galleries actually carry
 * (every sampled pet is s=1) and still small enough to be survivable.
 */
export const MAX_SCALE = 4;

/**
 * Classify a sheet by its pixel dimensions. Clean integer scales of either
 * grid are legal — upstream's own validator accepts them, up to `MAX_SCALE`.
 *
 * Returns null rather than throwing: an unrecognised sheet is a pack we skip
 * with a warning, never a crash (I4).
 *
 * Callers must run this on the *dimensions* before allocating pixels. It takes
 * width and height rather than an `ImageData` for exactly that reason.
 */
export function classifyGeometry(width: number, height: number): AtlasGeometry | null {
  for (const { version, rows } of VERSIONS) {
    const baseHeight = FRAME_HEIGHT * rows;
    if (width % BASE_WIDTH !== 0 || height % baseHeight !== 0) continue;
    const sx = width / BASE_WIDTH;
    const sy = height / baseHeight;
    if (sx !== sy || !Number.isInteger(sx) || sx < 1 || sx > MAX_SCALE) continue;
    return {
      version,
      rows,
      scale: sx,
      frameWidth: FRAME_WIDTH * sx,
      frameHeight: FRAME_HEIGHT * sx,
    };
  }
  return null;
}

/**
 * Spike D · F4 — v2 is v1 rows 0-8 plus two appended rows whose meaning is not
 * documented upstream and which no state of ours uses. Phase 1 ignores them.
 */
export const USABLE_ROWS = ATLAS_ROWS.length; // 9, for both versions

/**
 * Spike D · F2 — informational only. Three of four v1 sheets sampled matched
 * this vector, but `cactus` pads every row to 8 by repeating frames and `boba`
 * carries 7 on row 0.
 *
 * NEVER use this to drive playback. Frame counts are a property of the sheet,
 * not of the format, and must be detected per-sheet by `countLiveFrames`.
 */
export const MODAL_FRAME_COUNTS_V1: readonly number[] = [6, 8, 8, 4, 5, 8, 6, 6, 6];

/** A frame counts as live when this fraction of its pixels are opaque. */
export const LIVE_ALPHA_COVERAGE = 0.001;
const ALPHA_ON = 8;

/**
 * Count the live frames in one row of an already-decoded sheet.
 *
 * Frames are left-packed and trailing cells are transparent padding, so the
 * count is `index(last live) + 1`. Verified on all five Spike D sheets.
 */
export function countLiveFrames(sheet: ImageData, row: number, geometry: AtlasGeometry): number {
  const { frameWidth: fw, frameHeight: fh } = geometry;
  const perFrame = fw * fh;
  const threshold = perFrame * LIVE_ALPHA_COVERAGE;
  let last = -1;

  for (let col = 0; col < COLUMNS; col++) {
    let opaque = 0;
    const x0 = col * fw;
    const y0 = row * fh;
    for (let y = 0; y < fh; y++) {
      let idx = ((y0 + y) * sheet.width + x0) * 4 + 3;
      for (let x = 0; x < fw; x++, idx += 4) {
        if (sheet.data[idx]! > ALPHA_ON) opaque++;
      }
    }
    if (opaque > threshold) last = col;
  }

  return last + 1;
}

/** Per-row live frame counts for a decoded sheet. Length is always USABLE_ROWS. */
export function measureFrameCounts(sheet: ImageData, geometry: AtlasGeometry): number[] {
  return Array.from({ length: USABLE_ROWS }, (_, row) => countLiveFrames(sheet, row, geometry));
}
