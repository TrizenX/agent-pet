import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { classifyGeometry } from "./atlas.ts";
import { buildPack, describeProblem, type LoadedPack, parsePetJson } from "./loader.ts";

/**
 * Loading packs the shell found on disk.
 *
 * The shell reports what is *there*; validity is decided here, because deciding
 * it needs the decoded sheet and the geometry rules already live in
 * `atlas.ts`. A second implementation on the Rust side would be one more thing
 * to keep in step.
 *
 * Nothing here throws. These are files authored by other people for other
 * tools, and a bad one must cost the user a log line, not their pet (I4).
 */

export interface DiscoveredPack {
  readonly id: string;
  readonly manifest: string;
  readonly sheet: string | null;
  readonly root: string;
}

export interface PackListing {
  readonly packs: readonly LoadedPack[];
  /** Why each rejected pack was rejected. Shown in the event log. */
  readonly rejected: readonly { id: string; reason: string }[];
}

/**
 * Decode a sheet, refusing one whose geometry we would reject anyway.
 *
 * The order matters and used to be wrong. `getImageData` allocates
 * `width·height·4` bytes and `measureFrameCounts` then walks every one of them
 * synchronously, on the thread that draws the pet — so checking the geometry
 * *after* decoding means a hostile or merely silly sheet has already cost us
 * the memory and the freeze by the time we decide not to use it.
 * `createImageBitmap` gives us the dimensions first; that is where the decision
 * belongs.
 */
async function decode(url: string): Promise<ImageData> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
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

async function loadOne(found: DiscoveredPack): Promise<{ pack: LoadedPack } | { reason: string }> {
  if (!found.sheet) return { reason: "no spritesheet next to pet.json" };

  let manifestText: string;
  try {
    // Read through the asset protocol; a webview cannot open a raw path.
    manifestText = await (await fetch(convertFileSrc(found.manifest))).text();
  } catch (e) {
    return { reason: `pet.json unreadable (${e instanceof Error ? e.message : e})` };
  }

  const manifest = parsePetJson(manifestText);
  if ("kind" in manifest) return { reason: describeProblem(manifest) };

  let sheet: ImageData;
  try {
    sheet = await decode(convertFileSrc(found.sheet));
  } catch (e) {
    return { reason: e instanceof Error ? e.message : `spritesheet undecodable (${e})` };
  }

  const result = buildPack(manifest, sheet, convertFileSrc(found.sheet));
  if (!result.ok) return { reason: describeProblem(result.problem) };

  // Keyed by the directory the shell found it in, not by the `id` inside
  // `pet.json`. The tray writes a selection using the directory name and this
  // is what that selection is matched against, so the two have to be the same
  // string. They are not interchangeable: of the first 120 pets in the public
  // manifest, 13 declare an `id` that differs from their install slug (and one
  // declares none at all), and for every one of those, picking the pack in the
  // tray would have silently fallen back to the built-in pet.
  return { pack: { ...result.pack, id: found.id } };
}

/**
 * Everything installed, loaded and validated.
 *
 * Loaded in parallel and never rejected as a whole: one broken pack among five
 * must not cost the user the other four.
 */
export async function loadInstalledPacks(): Promise<PackListing> {
  let found: DiscoveredPack[] = [];
  try {
    found = await invoke<DiscoveredPack[]>("list_packs");
  } catch (e) {
    // Running outside the shell — or a command that failed, which is worth
    // saying rather than swallowing into an empty list.
    console.warn(`[packs] list_packs failed: ${e instanceof Error ? e.message : e}`);
    return { packs: [], rejected: [] };
  }

  const results = await Promise.all(
    found.map(async (f) => ({ id: f.id, outcome: await loadOne(f) })),
  );

  const packs: LoadedPack[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const { id, outcome } of results) {
    if ("pack" in outcome) packs.push(outcome.pack);
    else rejected.push({ id, reason: outcome.reason });
  }
  return { packs, rejected };
}
