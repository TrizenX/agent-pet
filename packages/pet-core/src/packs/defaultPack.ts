import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "./atlas.ts";
import manifest from "./default/pet.json";
import sheetUrl from "./default/spritesheet.png";
import { buildPack, describeProblem, type LoadedPack } from "./loader.ts";

/**
 * The built-in pet, loaded through the same code path as any other pack.
 *
 * §12.2: one code path from day one. Building a bespoke sprite system for the
 * default pet and refactoring it into packs later is how the two drift apart.
 */

async function decode(url: string): Promise<ImageData> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function loadDefaultPack(): Promise<LoadedPack> {
  const result = buildPack(manifest, await decode(sheetUrl), sheetUrl);
  if (result.ok) return result.pack;

  // Unreachable in a correct build, but the pet must exist regardless (I4):
  // a blank sheet is better than no window.
  console.error(`[packs] built-in pet failed to load: ${describeProblem(result.problem)}`);
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
