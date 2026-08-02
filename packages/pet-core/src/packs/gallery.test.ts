import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "./atlas.ts";

/**
 * The gallery client, which is the only code in the app that reaches the
 * network and the only code that causes a file to be written.
 *
 * What is pinned here is mostly what must *not* happen: no fetch before the
 * user asks, no write of a pack we have not decoded, no throw when the network
 * is missing. Offline is a normal state for this app, not an error condition.
 */

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));

const V1_W = FRAME_WIDTH * COLUMNS;
const V1_H = FRAME_HEIGHT * 9;

let fetched: string[] = [];
let responses: Record<
  string,
  { status?: number; body?: string; sheet?: [number, number]; size?: number }
> = {};
let cache: string | null = null;
let installs: Array<Record<string, unknown>> = [];

const MANIFEST = "https://petdex.dev/api/manifest";
/** Must be a host the CSP allows, or the client refuses before fetching. */
const CDN = "https://assets.petdex.dev";

function entry(slug: string) {
  return {
    slug,
    displayName: slug,
    kind: "creature",
    petJsonUrl: `${CDN}/${slug}/pet.json`,
    spritesheetUrl: `${CDN}/${slug}/sprite.webp`,
  };
}

beforeEach(() => {
  vi.resetModules();
  fetched = [];
  responses = {};
  cache = null;
  installs = [];

  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "gallery_cache_read") return cache;
    if (cmd === "gallery_cache_write") {
      cache = args.json as string;
      return null;
    }
    if (cmd === "install_pack") {
      installs.push(args);
      return "/packs/x";
    }
    throw new Error(`unexpected command ${cmd}`);
  });

  vi.stubGlobal("btoa", (s: string) => Buffer.from(s, "binary").toString("base64"));
  vi.stubGlobal("AbortSignal", { timeout: () => undefined });

  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    const r = responses[url];
    if (!r) throw new TypeError("network error");
    const status = r.status ?? 200;
    const size = r.size ?? 8;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h === "content-length" ? String(size) : null) },
      text: async () => r.body ?? "",
      blob: async () => ({
        type: "image/webp",
        size,
        arrayBuffer: async () => new ArrayBuffer(size),
        __sheet: r.sheet,
      }),
    };
  });

  vi.stubGlobal("createImageBitmap", async (blob: { __sheet?: [number, number] }) => {
    if (!blob.__sheet) throw new Error("undecodable");
    return { width: blob.__sheet[0], height: blob.__sheet[1], close: () => {} };
  });

  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4).fill(255),
        }),
      }),
    }),
  });
});

const load = async () => (await import("./gallery.ts")).loadGalleryIndex();
const install = async (e: ReturnType<typeof entry>) =>
  (await import("./gallery.ts")).installFromGallery(e);

describe("loadGalleryIndex", () => {
  it("fetches nothing until it is called", async () => {
    // Importing the module is what the app does when the picker is closed.
    await import("./gallery.ts");
    expect(fetched).toEqual([]);
  });

  it("reads the index and remembers it", async () => {
    responses[MANIFEST] = { body: JSON.stringify({ pets: [entry("guga")] }) };

    const index = await load();

    expect(index.entries.map((e) => e.slug)).toEqual(["guga"]);
    expect(index.cached).toBe(false);
    expect(cache).not.toBeNull();
  });

  it("prefers the cache to the network", async () => {
    cache = JSON.stringify({ pets: [entry("frog")] });

    const index = await load();

    expect(index.cached).toBe(true);
    expect(index.entries.map((e) => e.slug)).toEqual(["frog"]);
    expect(fetched).toEqual([]);
  });

  it("says so when the gallery is unreachable, and does not throw", async () => {
    const index = await load();

    expect(index.entries).toEqual([]);
    expect(index.error).toMatch(/could not reach/);
  });

  it("survives a corrupt cache by fetching", async () => {
    cache = "{{{ not json";
    responses[MANIFEST] = { body: JSON.stringify({ pets: [entry("slime")] }) };

    const index = await load();

    expect(index.entries.map((e) => e.slug)).toEqual(["slime"]);
    expect(fetched).toEqual([MANIFEST]);
  });

  it("drops entries missing a field rather than offering a button that cannot work", async () => {
    responses[MANIFEST] = {
      body: JSON.stringify({ pets: [entry("good"), { slug: "half", displayName: "Half" }] }),
    };

    expect((await load()).entries.map((e) => e.slug)).toEqual(["good"]);
  });
});

describe("installFromGallery", () => {
  it("refuses a host the content security policy would block anyway", async () => {
    // A compromised manifest pointing the sheet somewhere else entirely. The
    // CSP is what enforces this; checking here is what makes the refusal say so
    // instead of looking like a dropped connection.
    const evil = { ...entry("evil"), spritesheetUrl: "file:///etc/passwd" };
    responses[`${CDN}/evil/pet.json`] = { body: JSON.stringify({ id: "evil" }) };

    const result = await install(evil);

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/not a host this build is allowed/);
    expect(fetched).not.toContain("file:///etc/passwd");
    expect(installs).toEqual([]);
  });

  it("refuses a sheet that decodes fine but weighs too much", async () => {
    // The geometry is impeccable — 1536x1872 — and the file is 40 MB, because
    // a PNG can carry anything in a chunk decoders skip. Pixels prove nothing
    // about bytes.
    responses[`${CDN}/fat/pet.json`] = { body: JSON.stringify({ id: "fat" }) };
    responses[`${CDN}/fat/sprite.webp`] = { sheet: [V1_W, V1_H], size: 40 * 1024 * 1024 };

    expect(await install(entry("fat"))).toMatchObject({ ok: false });
    expect(installs).toEqual([]);
  });

  it("sends the sheet as base64, not as a list of numbers", async () => {
    responses[`${CDN}/guga/pet.json`] = { body: JSON.stringify({ id: "guga" }) };
    responses[`${CDN}/guga/sprite.webp`] = { sheet: [V1_W, V1_H] };

    await install(entry("guga"));

    expect(typeof installs[0]?.sheetBase64).toBe("string");
    expect(installs[0]).not.toHaveProperty("sheet");
  });

  it("writes a pack it has decoded", async () => {
    responses[`${CDN}/guga/pet.json`] = { body: JSON.stringify({ id: "guga" }) };
    responses[`${CDN}/guga/sprite.webp`] = { sheet: [V1_W, V1_H] };

    const result = await install(entry("guga"));

    expect(result).toEqual({ ok: true, id: "guga" });
    expect(installs).toHaveLength(1);
    expect(installs[0]?.slug).toBe("guga");
    // The name on disk is ours, never the remote file's.
    expect(installs[0]?.sheetName).toBe("spritesheet.webp");
  });

  it("writes nothing when the sheet is the wrong shape", async () => {
    responses[`${CDN}/bad/pet.json`] = { body: JSON.stringify({ id: "bad" }) };
    responses[`${CDN}/bad/sprite.webp`] = { sheet: [100, 100] };

    const result = await install(entry("bad"));

    expect(result).toMatchObject({ ok: false });
    expect(installs).toEqual([]);
  });

  it("writes nothing when the sheet is a legal grid but absurdly large", async () => {
    responses[`${CDN}/huge/pet.json`] = { body: JSON.stringify({ id: "huge" }) };
    responses[`${CDN}/huge/sprite.webp`] = { sheet: [V1_W * 16, V1_H * 16] };

    expect(await install(entry("huge"))).toMatchObject({ ok: false });
    expect(installs).toEqual([]);
  });

  it("writes nothing when the manifest is unreadable", async () => {
    responses[`${CDN}/junk/pet.json`] = { body: "{{{" };
    responses[`${CDN}/junk/sprite.webp`] = { sheet: [V1_W, V1_H] };

    expect(await install(entry("junk"))).toMatchObject({ ok: false });
    expect(installs).toEqual([]);
  });

  it("reports a failed download instead of throwing", async () => {
    responses[`${CDN}/gone/pet.json`] = { status: 404 };
    responses[`${CDN}/gone/sprite.webp`] = { status: 404, sheet: [V1_W, V1_H] };

    expect(await install(entry("gone"))).toMatchObject({ ok: false });
    expect(installs).toEqual([]);
  });
});
