import { classifyGeometry } from "./atlas.ts";
import { describeProblem } from "./loader.ts";

/**
 * Turning a spritesheet into pixels, once.
 *
 * Three callers need this — the built-in pet, packs found on disk, and packs
 * downloaded from the gallery — and the third was the point at which having two
 * copies became having three. They must agree, because the ordering below is
 * load-bearing rather than incidental.
 */

/**
 * Decode a sheet, refusing one whose geometry we would reject anyway.
 *
 * The order matters. `getImageData` allocates `width·height·4` bytes and
 * `measureFrameCounts` then walks every one of them synchronously, on the
 * thread that draws the pet — so checking geometry *after* decoding means a
 * hostile or merely silly sheet has already cost us the memory and the freeze
 * by the time we decide not to use it. `createImageBitmap` gives us the
 * dimensions first; that is where the decision belongs.
 *
 * Throws with a legible reason. Every caller turns that into a skipped pack.
 */
export async function decodeSheet(source: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(source);
  const geometry = classifyGeometry(bitmap.width, bitmap.height);
  if (!geometry) {
    const { width, height } = bitmap;
    bitmap.close();
    throw new Error(describeProblem({ kind: "bad-geometry", width, height }));
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error("no 2d context");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** The same, for a sheet we reach by URL rather than by bytes. */
export async function decodeSheetAt(url: string): Promise<ImageData> {
  return decodeSheet(await (await fetch(url)).blob());
}
