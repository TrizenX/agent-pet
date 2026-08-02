import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "./atlas.ts";

/**
 * `discovery.ts` is the seam between three strangers' files and our renderer,
 * and it shipped without a test. These pin the two things that are not obvious
 * from reading it: which id a loaded pack ends up with, and that the geometry
 * is decided before any pixel buffer is allocated.
 */

const invoke = vi.fn();
const convertFileSrc = vi.fn((p: string) => `asset://${p}`);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => convertFileSrc(p),
}));

/** Dimensions handed to `createImageBitmap`, in call order. */
let decoded: Array<[number, number]> = [];
/** Dimensions that reached `getImageData` — the expensive step. */
let readBack: Array<[number, number]> = [];

function sheetOf(width: number, height: number) {
  return { width, height };
}

/** What `list_packs` claims is on disk, and what each file contains. */
let onDisk: Array<{ id: string; manifest: string; sheet: string | null; root: string }> = [];
let files: Record<string, string> = {};
let sheets: Record<string, { width: number; height: number }> = {};

beforeEach(() => {
  vi.resetModules();
  decoded = [];
  readBack = [];
  onDisk = [];
  files = {};
  sheets = {};

  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_packs") return onDisk;
    throw new Error(`unexpected command ${cmd}`);
  });

  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace(/^asset:\/\//, "");
    if (path in files) return { text: async () => files[path], blob: async () => ({ path }) };
    if (path in sheets) return { text: async () => "", blob: async () => ({ path }) };
    throw new Error(`ENOENT ${path}`);
  });

  vi.stubGlobal("createImageBitmap", async (blob: { path: string }) => {
    const s = sheets[blob.path];
    if (!s) throw new Error("undecodable");
    decoded.push([s.width, s.height]);
    return { ...s, close: () => {} };
  });

  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          readBack.push([w, h]);
          // Every pixel opaque: enough for `measureFrameCounts` to see frames.
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
        },
      }),
    }),
  });
});

/** A pack whose `pet.json` id deliberately differs from its directory. */
function install(dir: string, declaredId: string, width: number, height: number) {
  const manifest = `/packs/${dir}/pet.json`;
  const sheet = `/packs/${dir}/spritesheet.webp`;
  onDisk.push({ id: dir, manifest, sheet, root: "petdex" });
  files[manifest] = JSON.stringify({ id: declaredId, displayName: declaredId });
  sheets[sheet] = sheetOf(width, height);
}

const V1_W = FRAME_WIDTH * COLUMNS; // 1536
const V1_H = FRAME_HEIGHT * 9; // 1872

async function load() {
  const { loadInstalledPacks } = await import("./discovery.ts");
  return loadInstalledPacks();
}

describe("loadInstalledPacks", () => {
  it("keys a pack by its directory, not by the id inside pet.json", async () => {
    // The real case: `npx petdex install wukong-5` writes a directory named
    // after the slug, and the author's pet.json says `wukong`.
    install("wukong-5", "wukong", V1_W, V1_H);

    const { packs, rejected } = await load();

    expect(rejected).toEqual([]);
    expect(packs.map((p) => p.id)).toEqual(["wukong-5"]);
  });

  it("rejects an oversized sheet without ever reading its pixels", async () => {
    // A legal v1 grid at scale 16 — 2.9 GB of ImageData, and a synchronous
    // 735-million-pixel scan on the thread that draws the pet.
    install("enormous", "enormous", V1_W * 16, V1_H * 16);

    const { packs, rejected } = await load();

    expect(packs).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/24576×29952/);
    expect(decoded).toEqual([[V1_W * 16, V1_H * 16]]);
    expect(readBack).toEqual([]);
  });

  it("accepts a sheet at the largest scale it will decode", async () => {
    install("big", "big", V1_W * 4, V1_H * 4);

    const { packs } = await load();

    expect(packs[0]?.geometry.scale).toBe(4);
    expect(readBack).toEqual([[V1_W * 4, V1_H * 4]]);
  });

  it("one broken pack does not cost the others", async () => {
    install("good", "good", V1_W, V1_H);
    install("wrong-size", "wrong-size", 100, 100);
    onDisk.push({ id: "no-sheet", manifest: "/packs/no-sheet/pet.json", sheet: null, root: "app" });
    files["/packs/no-sheet/pet.json"] = JSON.stringify({ id: "no-sheet" });

    const { packs, rejected } = await load();

    expect(packs.map((p) => p.id)).toEqual(["good"]);
    expect(rejected.map((r) => r.id).sort()).toEqual(["no-sheet", "wrong-size"]);
  });

  it("survives the shell command failing", async () => {
    invoke.mockRejectedValue(new Error("no shell"));

    await expect(load()).resolves.toEqual({ packs: [], rejected: [] });
  });
});
