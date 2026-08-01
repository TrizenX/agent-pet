/**
 * Turning a pet pack on disk into something renderable.
 *
 * Spec §12. The format is not ours — we adopted the community atlas rather than
 * inventing one (D10), which is why the loader is defensive: it is reading
 * files authored by other people, for other tools, with no schema enforcement
 * anywhere. Nothing here may throw. An unreadable pack is skipped with a
 * warning; the default pet always remains (I4).
 */

import {
  type AtlasGeometry,
  type AtlasRow,
  classifyGeometry,
  measureFrameCounts,
  ROW_INDEX,
  USABLE_ROWS,
} from "./atlas.ts";
import { REQUIRED_ROWS } from "./stateMap.ts";

export interface PetJson {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly spritesheetPath: string;
}

export interface LoadedPack {
  readonly id: string;
  readonly displayName: string;
  /** Resolved URL the renderer can put in `background-image`. */
  readonly sheetUrl: string;
  readonly geometry: AtlasGeometry;
  /** Live frames per row, measured from this sheet — never assumed (F2). */
  readonly frameCounts: readonly number[];
  /**
   * Rows with no frames, which the renderer must substitute for. Empty on a
   * well-formed pack.
   */
  readonly missingRows: readonly AtlasRow[];
  /** True when row 2 is absent and must be synthesised by flipping row 1 (F3). */
  readonly mirrorRunningLeft: boolean;
}

export type PackProblem =
  | { kind: "unreadable-json"; detail: string }
  | { kind: "bad-manifest"; detail: string }
  | { kind: "bad-geometry"; width: number; height: number }
  | { kind: "empty-sheet" };

export type PackResult = { ok: true; pack: LoadedPack } | { ok: false; problem: PackProblem };

/** Parse `pet.json`. Every field is treated as untrusted. */
export function parsePetJson(text: string): PetJson | PackProblem {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: "unreadable-json", detail: e instanceof Error ? e.message : String(e) };
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "bad-manifest", detail: "not an object" };
  }

  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : undefined;
  if (!id) return { kind: "bad-manifest", detail: "missing id" };

  return {
    id,
    displayName: typeof o.displayName === "string" && o.displayName ? o.displayName : id,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
    // Real packs in the wild sometimes omit it; the conventional filename is
    // the sensible fallback rather than a reason to reject the pack.
    spritesheetPath:
      typeof o.spritesheetPath === "string" && o.spritesheetPath
        ? o.spritesheetPath
        : "spritesheet.png",
  };
}

/**
 * Build a pack from a decoded sheet.
 *
 * Split from any file access so it can be tested with a synthetic `ImageData`
 * and no filesystem, no Tauri and no image decoder.
 */
export function buildPack(manifest: PetJson, sheet: ImageData, sheetUrl: string): PackResult {
  const geometry = classifyGeometry(sheet.width, sheet.height);
  if (!geometry) {
    return {
      ok: false,
      problem: { kind: "bad-geometry", width: sheet.width, height: sheet.height },
    };
  }

  const frameCounts = measureFrameCounts(sheet, geometry);
  if (frameCounts.every((n) => n === 0)) {
    return { ok: false, problem: { kind: "empty-sheet" } };
  }

  const missingRows = REQUIRED_ROWS.filter((row) => (frameCounts[ROW_INDEX[row]] ?? 0) === 0);

  return {
    ok: true,
    pack: {
      id: manifest.id,
      displayName: manifest.displayName,
      sheetUrl,
      geometry,
      frameCounts,
      missingRows,
      // F3: rows 1 and 2 are a mirror pair on real sheets, so a pack that only
      // drew one direction is recoverable rather than broken.
      mirrorRunningLeft:
        (frameCounts[ROW_INDEX["running-left"]] ?? 0) === 0 &&
        (frameCounts[ROW_INDEX["running-right"]] ?? 0) > 0,
    },
  };
}

export interface ResolvedRow {
  /** Row index to sample from the sheet. */
  readonly row: number;
  readonly frames: number;
  /** Draw mirrored — only ever true for the synthesised left-facing run. */
  readonly flip: boolean;
  /** True when the requested row was absent and something else is standing in. */
  readonly substituted: boolean;
}

/**
 * Which row to actually draw for a requested one.
 *
 * A pack missing a row must never crash or freeze the pet (I4), so there is
 * always an answer: mirror the opposite run, else fall back to `idle`, else
 * take the first row that has any frames at all.
 */
export function resolveRow(pack: LoadedPack, want: AtlasRow): ResolvedRow {
  const index = ROW_INDEX[want];
  const frames = pack.frameCounts[index] ?? 0;
  if (frames > 0) return { row: index, frames, flip: false, substituted: false };

  if (want === "running-left" && pack.mirrorRunningLeft) {
    const right = ROW_INDEX["running-right"];
    return { row: right, frames: pack.frameCounts[right] ?? 0, flip: true, substituted: true };
  }

  const idle = ROW_INDEX.idle;
  if ((pack.frameCounts[idle] ?? 0) > 0) {
    return { row: idle, frames: pack.frameCounts[idle] ?? 0, flip: false, substituted: true };
  }

  const firstLive = pack.frameCounts.findIndex((n) => n > 0);
  return {
    row: firstLive >= 0 ? firstLive : 0,
    frames: firstLive >= 0 ? (pack.frameCounts[firstLive] ?? 1) : 1,
    flip: false,
    substituted: true,
  };
}

export function describeProblem(problem: PackProblem): string {
  switch (problem.kind) {
    case "unreadable-json":
      return `pet.json could not be parsed (${problem.detail})`;
    case "bad-manifest":
      return `pet.json is not a valid manifest (${problem.detail})`;
    case "bad-geometry":
      return `spritesheet is ${problem.width}×${problem.height}, which is not an 8×${USABLE_ROWS} or 8×11 grid of 192×208 frames`;
    case "empty-sheet":
      return "spritesheet is entirely transparent";
  }
}
