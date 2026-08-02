// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "./packs/atlas.ts";

/**
 * The wiring, end to end: a hook payload in, pixels out.
 *
 * Everything else in this suite tests a piece — the adapter maps, the machine
 * transitions, `speechFor` words it, `SpeechBubble` renders a given string. All
 * of them passed while the pet on screen said "Chạy…" for a whole afternoon,
 * because every bug was in the *joins*: a prop `App` stopped passing, a string
 * derived twice and diverging, a bubble sized to half the window.
 *
 * Four hundred and fifty tests and not one of them looked at what the user
 * looks at. So this one starts where the shell does — a raw hook payload on the
 * `agent-raw` channel — and asserts the DOM.
 */

// ── The shell, as far as the frontend can tell ──────────────────────────────

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
const invoked: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let settings: Record<string, unknown>;

/** Deliver one shell event, the way `emit` from Rust would. */
function emit(channel: string, payload: unknown) {
  for (const h of listeners.get(channel) ?? []) h({ payload });
}

/** One raw hook payload, exactly as `spawn_drain` forwards it. */
function hook(body: Record<string, unknown>, at = 1_000) {
  emit("agent-raw", { source: "claude-code", payload: JSON.stringify(body), at });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Handler) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invoked.push({ cmd, args });
    if (cmd === "get_settings") return Promise.resolve(settings);
    if (cmd === "list_packs") return Promise.resolve([]);
    if (cmd === "endpoint_url") return Promise.resolve("http://127.0.0.1:48200/pet-event");
    return Promise.resolve(null);
  },
}));

// ── Enough of a browser to decode the built-in pet ──────────────────────────

const SHEET_W = FRAME_WIDTH * COLUMNS;
const SHEET_H = FRAME_HEIGHT * 9;

function stubImageDecoding() {
  vi.stubGlobal("fetch", async () => ({ blob: async () => ({}) }));
  vi.stubGlobal("createImageBitmap", async () => ({
    width: SHEET_W,
    height: SHEET_H,
    close: () => {},
  }));
  const ctx = {
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      // Every pixel opaque, so every row reports frames.
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }),
  };
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = realCreate(tag);
    if (tag === "canvas") Object.assign(el, { getContext: () => ctx });
    return el;
  });
}

/** Render `App` and let the pack decode settle. */
async function mount() {
  const { App } = await import("./App.tsx");
  render(<App />);
  // Two microtask drains: one for the settings/pack promises, one for the
  // state they set.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const lines = () =>
  [...document.querySelectorAll(".pet-bubble-line")].map((n) => n.textContent?.trim() ?? "");

beforeEach(() => {
  vi.resetModules();
  listeners.clear();
  invoked.length = 0;
  settings = {
    click_through: false,
    glyphs_enabled: true,
    scale: 1,
    hidden: false,
    pack: "",
    wander: false,
    locale: "vi",
  };
  stubImageDecoding();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a hook payload reaches the screen", () => {
  it("says which file it is editing, not that it is editing", async () => {
    await mount();

    await act(async () => {
      hook({
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/w/viparse",
        tool_name: "Edit",
        tool_input: { file_path: "/x/engine.ts" },
      });
    });

    // The label came from the adapter, through the machine, into the bubble.
    // Every one of those hops was broken at some point and every one had a
    // passing unit test.
    expect(screen.getByText(/engine\.ts/)).toBeTruthy();
  });

  it("names the command rather than the tool kind", async () => {
    await mount();

    await act(async () => {
      hook({
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/w/p",
        tool_name: "Bash",
        tool_input: { command: "cd ~/p && pnpm verify --silent" },
      });
    });

    expect(lines()[0]).toContain("pnpm verify");
  });

  it("stops asking once the approved tool finishes", async () => {
    // The regression that made the pet ask "May I?" long after the user said
    // yes. Only observable through the whole pipeline: the machine test covers
    // the transition, and this covers that the transition reaches the bubble.
    await mount();

    await act(async () => {
      hook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/w/p", tool_name: "Bash" });
      hook({
        hook_event_name: "Notification",
        session_id: "s1",
        cwd: "/w/p",
        notification_type: "permission_prompt",
      });
    });
    expect(lines()[0]).toMatch(/nha\?|May I/);

    await act(async () => {
      hook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: "/w/p", tool_name: "Bash" });
    });
    expect(lines()[0]).not.toMatch(/nha\?|May I/);
  });
});

describe("several sessions at once", () => {
  const busy = (id: string, cwd: string, file: string) => ({
    hook_event_name: "PreToolUse",
    session_id: id,
    cwd,
    tool_name: "Edit",
    tool_input: { file_path: file },
  });

  it("gives every session a line", async () => {
    await mount();

    await act(async () => {
      hook(busy("a", "/w/viparse", "/x/excel.py"));
      hook(busy("b", "/w/agent-pet", "/x/mapping.ts"));
      hook(busy("c", "/w/corpus", "/x/atlas.ts"));
    });

    expect(lines()).toHaveLength(3);
    expect(document.body.textContent).toContain("viparse");
    expect(document.body.textContent).toContain("agent-pet");
  });

  it("puts whoever is waiting at the top and marks them", async () => {
    await mount();

    await act(async () => {
      hook(busy("a", "/w/agent-pet", "/x/mapping.ts"));
      hook(busy("b", "/w/viparse", "/x/excel.py"));
      hook({
        hook_event_name: "Notification",
        session_id: "b",
        cwd: "/w/viparse",
        notification_type: "permission_prompt",
      });
    });

    const marked = document.querySelectorAll(".pet-bubble-line[data-attention]");
    expect(marked).toHaveLength(1);
    expect(lines()[0]).toContain("viparse");
  });

  it("labels each line with its own project", async () => {
    // Deliberately *not* claiming anything about truncation: jsdom does no
    // layout, so `max-width` and `text-overflow` are invisible here and an
    // assertion about an ellipsis would pass whether or not one appeared. That
    // belongs to the CSS check in `window.test.ts` and to a screenshot.
    await mount();

    await act(async () => {
      hook(busy("a", "/w/agent-pet", "/x/a.ts"));
      hook(busy("b", "/w/viparse-landingpage", "/x/b.ts"));
    });

    expect(screen.getByText("agent-pet")).toBeTruthy();
    expect(screen.getByText("viparse-landingpage")).toBeTruthy();
  });

  it("switches register: chatty alone, terse in a list", async () => {
    await mount();

    await act(async () => {
      hook(busy("a", "/w/viparse", "/x/engine.ts"));
    });
    expect(lines()[0]).toBe("Đụng vào engine.ts nè, hồi hộp ghê");

    await act(async () => {
      hook(busy("b", "/w/agent-pet", "/x/mapping.ts"));
    });
    // `textContent` runs the two spans together — the gap between them is CSS,
    // not a text node — so match the parts rather than a rendered-looking whole.
    expect(lines().some((l) => l.includes("viparse") && l.includes("Sửa engine.ts"))).toBe(true);
    expect(lines().every((l) => !l.includes("hồi hộp"))).toBe(true);
  });
});

describe("what the pet is drawing", () => {
  it("animates the row the state maps to", async () => {
    await mount();

    await act(async () => {
      hook({
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/w/p",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
    });

    const sprite = document.querySelector(".pet-sprite") as HTMLElement | null;
    expect(sprite?.dataset.state).toBe("working.digging");
  });

  it("keeps the bubble, badge-free, anchored to the pet's height", async () => {
    // `--pet-h` is what the bubble and the glyph position against. Pinned here
    // because when it was missing they anchored to the window's corners
    // instead, and a small pet ended up with a bubble floating above it.
    await mount();

    expect(document.documentElement.style.getPropertyValue("--pet-h")).toBe(
      `${FRAME_HEIGHT * 1}px`,
    );
    expect(document.querySelector(".pet-badge")).toBeNull();
  });

  it("never walks when the setting is off", async () => {
    await mount();

    await act(async () => {
      hook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/w/p", tool_name: "Bash" });
    });

    const walks = invoked.filter((i) => i.cmd === "set_walking" && i.args.on === true);
    expect(walks).toEqual([]);
  });
});

describe("a session that has gone quiet", () => {
  it("drops out of the bubble once it is asleep", async () => {
    // The bubble answers "what is happening". A row reading "Zzz…" answers a
    // question nobody asked, and sits between the user and the sessions that
    // are actually live.
    //
    // Driven by a session ending rather than by ninety seconds of silence:
    // both land in `sleeping`, which is what the filter keys on, and one of
    // them does not need the clock.
    await mount();

    await act(async () => {
      hook({
        hook_event_name: "PreToolUse",
        session_id: "done",
        cwd: "/w/viparse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      hook({
        hook_event_name: "PreToolUse",
        session_id: "busy",
        cwd: "/w/agent-pet",
        tool_name: "Edit",
        tool_input: { file_path: "/x/mapping.ts" },
      });
    });
    expect(lines()).toHaveLength(2);

    await act(async () => {
      hook({ hook_event_name: "SessionEnd", session_id: "done", cwd: "/w/viparse" });
    });

    const remaining = lines();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("mapping.ts");
  });

  it("says nothing at all when every session is asleep", async () => {
    await mount();

    await act(async () => {
      hook({ hook_event_name: "PreToolUse", session_id: "a", cwd: "/w/p", tool_name: "Bash" });
    });
    expect(lines()).toHaveLength(1);

    await act(async () => {
      hook({ hook_event_name: "SessionEnd", session_id: "a", cwd: "/w/p" });
    });

    // No bubble, rather than a bubble saying nothing is happening. The sleeping
    // sprite already says that.
    expect(document.querySelector(".pet-bubble")).toBeNull();
  });
});
