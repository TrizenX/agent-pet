import { invoke } from "@tauri-apps/api/core";
import { decodeSheet } from "./decode.ts";
import { buildPack, describeProblem, parsePetJson } from "./loader.ts";

/**
 * The public gallery, fetched only when someone asks for it.
 *
 * Spec §12.4. Three rules, and each of them is a thing the app must keep doing
 * when the network is not there:
 *
 * - **Nothing is fetched until the picker opens.** Not on launch, not
 *   speculatively. The pet is fully functional with no network at all, and a
 *   background request would quietly make that untrue.
 * - **The index is cached for a day** in app-data. It is metadata — slugs and
 *   URLs — not art, so caching it is not re-hosting.
 * - **We never hold the art.** The bytes go from the gallery's CDN to the
 *   user's disk because the user pressed a button. §17.2.
 *
 * The network lives here rather than in the shell because the webview already
 * has an HTTP stack and the gallery serves `Access-Control-Allow-Origin: *`.
 * The shell's only job is to write the file, which is the one thing the webview
 * cannot do.
 */

const MANIFEST_URL = "https://petdex.dev/api/manifest";

/**
 * Hosts the production CSP's `connect-src` permits.
 *
 * Duplicated from `tauri.conf.json` on purpose. The CSP is the thing that
 * actually enforces this — it is the only layer stopping a manifest from
 * pointing `spritesheetUrl` at `file://` or any other host — but a CSP refusal
 * surfaces in the webview as a generic `TypeError`, indistinguishable from
 * being offline. Checking first turns "could not download it" into a sentence
 * that names the host, which is what someone would need if the gallery ever
 * moves its CDN.
 */
const ALLOWED_HOSTS = ["petdex.dev", "assets.petdex.dev"];

/** Nothing waits forever. A stalled socket is commoner than a refused one. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The largest sheet we will pull down.
 *
 * Must match `MAX_SHEET_BYTES` in `gallery.rs`, which is the enforcing copy.
 * This one exists so the refusal happens before the bytes are in memory rather
 * than after. The geometry check is *not* a size check: a PNG at a perfectly
 * ordinary 1536×1872 can carry megabytes in an ancillary chunk that every
 * decoder skips, so the pixels prove nothing about the file.
 */
const MAX_SHEET_BYTES = 8 * 1024 * 1024;

function allowed(url: string): boolean {
  try {
    return ALLOWED_HOSTS.includes(new URL(url).host);
  } catch {
    return false;
  }
}

/** `fetch`, but it gives up. */
async function get(url: string): Promise<Response> {
  if (!allowed(url)) {
    throw new Error(`${url} is not a host this build is allowed to reach`);
  }
  return fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export interface GalleryEntry {
  readonly slug: string;
  readonly displayName: string;
  readonly kind: string;
  readonly spritesheetUrl: string;
  readonly petJsonUrl: string;
}

export interface GalleryIndex {
  readonly entries: readonly GalleryEntry[];
  /** Served from the day-old cache rather than the network. */
  readonly cached: boolean;
  /** Set when we have nothing to show. The picker states it; nothing throws. */
  readonly error?: string;
}

function parseIndex(json: string): GalleryEntry[] {
  const raw: unknown = JSON.parse(json);
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { pets?: unknown }).pets)
      ? (raw as { pets: unknown[] }).pets
      : [];

  const entries: GalleryEntry[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    // Every field is required. An entry missing one is an entry we could not
    // install anyway, and dropping it here means the picker never offers a
    // button that cannot work.
    if (
      typeof e.slug === "string" &&
      typeof e.displayName === "string" &&
      typeof e.spritesheetUrl === "string" &&
      typeof e.petJsonUrl === "string"
    ) {
      entries.push({
        slug: e.slug,
        displayName: e.displayName,
        kind: typeof e.kind === "string" ? e.kind : "pet",
        spritesheetUrl: e.spritesheetUrl,
        petJsonUrl: e.petJsonUrl,
      });
    }
  }
  return entries;
}

/**
 * The gallery index: cache first, network second, a sentence third.
 *
 * Never rejects. Offline is a normal state for this app, not an error
 * condition — the pet keeps working and the picker says what happened.
 */
export async function loadGalleryIndex(): Promise<GalleryIndex> {
  let cached: string | null = null;
  try {
    cached = await invoke<string | null>("gallery_cache_read");
  } catch (e) {
    console.warn(`[gallery] cache unreadable: ${e instanceof Error ? e.message : e}`);
  }
  if (cached) {
    try {
      return { entries: parseIndex(cached), cached: true };
    } catch {
      // A corrupt cache costs one round trip, not a broken picker.
    }
  }

  let text: string;
  try {
    const response = await get(MANIFEST_URL);
    if (!response.ok) {
      return { entries: [], cached: false, error: `the gallery answered ${response.status}` };
    }
    text = await response.text();
  } catch {
    return {
      entries: [],
      cached: false,
      error: "could not reach the gallery — the pet works fine without it",
    };
  }

  let entries: GalleryEntry[];
  try {
    entries = parseIndex(text);
  } catch {
    return { entries: [], cached: false, error: "the gallery sent something unreadable" };
  }

  if (entries.length > 0) {
    try {
      await invoke("gallery_cache_write", { json: text });
    } catch (e) {
      console.warn(`[gallery] could not cache the index: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { entries, cached: false };
}

export type InstallResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Download a pack, prove it works, and only then write it.
 *
 * Validation before the write rather than after. Deleting a bad pack afterwards
 * is a weaker guarantee — it loses to being killed between the two steps, and
 * leaves a directory that `discover()` re-reads and re-rejects at every future
 * startup.
 */
export async function installFromGallery(entry: GalleryEntry): Promise<InstallResult> {
  let petJson: string;
  let sheetBlob: Blob;
  try {
    const [manifestResponse, sheetResponse] = await Promise.all([
      get(entry.petJsonUrl),
      get(entry.spritesheetUrl),
    ]);
    if (!manifestResponse.ok || !sheetResponse.ok) {
      return {
        ok: false,
        reason: `download failed (${manifestResponse.status}/${sheetResponse.status})`,
      };
    }

    // Refuse on the declared length before reading the body, when the server
    // is honest enough to declare one.
    const declared = Number(sheetResponse.headers?.get?.("content-length") ?? 0);
    if (declared > MAX_SHEET_BYTES) {
      return { ok: false, reason: `the spritesheet is ${declared} bytes, which is too large` };
    }

    petJson = await manifestResponse.text();
    sheetBlob = await sheetResponse.blob();
  } catch (e) {
    // Covers offline, a refused connection, a host outside the allowlist, and
    // the timeout — all of which used to be the same silent shrug.
    return { ok: false, reason: `could not download it: ${e instanceof Error ? e.message : e}` };
  }

  // And on the real length, for a server that was not.
  if (sheetBlob.size > MAX_SHEET_BYTES) {
    return { ok: false, reason: `the spritesheet is ${sheetBlob.size} bytes, which is too large` };
  }

  const manifest = parsePetJson(petJson);
  if ("kind" in manifest) return { ok: false, reason: describeProblem(manifest) };

  let sheet: ImageData;
  try {
    sheet = await decodeSheet(sheetBlob);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  // `sheetUrl` is a placeholder here: we only want the geometry verdict, and
  // the real URL cannot exist until the file is on disk.
  const built = buildPack(manifest, sheet, "");
  if (!built.ok) return { ok: false, reason: describeProblem(built.problem) };

  // The name on disk is chosen by us from the slug, never taken from the
  // downloaded `pet.json` — a remote document does not get to pick a filename.
  const sheetName = sheetBlob.type === "image/png" ? "spritesheet.png" : "spritesheet.webp";
  try {
    await invoke("install_pack", {
      slug: entry.slug,
      petJson,
      sheetBase64: base64(await sheetBlob.arrayBuffer()),
      sheetName,
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, id: entry.slug };
}

/**
 * Bytes for the IPC boundary.
 *
 * Not `Array.from(new Uint8Array(...))`. Tauri only takes its raw-bytes fast
 * path when the whole invoke payload is a typed array, which it never is for a
 * command with named arguments — so an array of bytes is serialised as a JSON
 * list of decimal numbers. Measured at fifteen to twenty times the source: an
 * 8 MB sheet became a 154 MB array and a 30-million-character string. Base64 is
 * 1.33×, and `btoa` needs chunking because the argument list has a limit.
 */
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
