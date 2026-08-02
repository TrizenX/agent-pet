import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
    return { reason: `spritesheet undecodable (${e instanceof Error ? e.message : e})` };
  }

  const result = buildPack(manifest, sheet, convertFileSrc(found.sheet));
  return result.ok ? { pack: result.pack } : { reason: describeProblem(result.problem) };
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
