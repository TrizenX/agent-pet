import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "./atlas.ts";
import { decodeSheetAt } from "./decode.ts";
import manifest from "./default/pet.json";
import sheetUrl from "./default/spritesheet.png";
import { buildPack, describeProblem, type LoadedPack } from "./loader.ts";

/**
 * The built-in pet, loaded through the same code path as any other pack.
 *
 * §12.2: one code path from day one. Building a bespoke sprite system for the
 * default pet and refactoring it into packs later is how the two drift apart.
 */

export async function loadDefaultPack(): Promise<LoadedPack> {
  let sheet: ImageData;
  try {
    sheet = await decodeSheetAt(sheetUrl);
  } catch (e) {
    // The one pack with nothing beneath it. An installed pack that fails to
    // load falls back to this one; this one falling back to a rejected promise
    // left `pack` null forever and the window rendering nothing — the terminal
    // state I4 exists to forbid, reached through the file that claims to
    // prevent it.
    console.error(`[packs] built-in sheet undecodable: ${e instanceof Error ? e.message : e}`);
    return fallbackPack();
  }

  const result = buildPack(manifest, sheet, sheetUrl);
  if (result.ok) return result.pack;

  console.error(`[packs] built-in pet failed to load: ${describeProblem(result.problem)}`);
  return fallbackPack();
}

/** A pet-shaped nothing. A blank sheet is better than no window (I4). */
function fallbackPack(): LoadedPack {
  return {
    id: "fallback",
    displayName: "Fallback",
    sheetUrl: "",
    geometry: {
      version: "v1",
      rows: 9,
      scale: 1,
      frameWidth: FRAME_WIDTH,
      frameHeight: FRAME_HEIGHT,
    },
    frameCounts: Array<number>(COLUMNS + 1)
      .fill(1)
      .slice(0, 9),
    missingRows: [],
    mirrorRunningLeft: false,
  };
}
