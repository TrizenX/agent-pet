import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/mapping.ts";
import { hooksBlock } from "../src/record.ts";
import { installHooks, ourUrl, uninstallHooks } from "../src/settings.ts";

const PORT = 48200;
const block = () => hooksBlock(PORT) as Record<string, unknown[]>;

let dir: string;
let file: string;

/** A settings file with a hook of the user's own that we must never touch. */
const USER_SETTINGS = {
  model: "opus",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }],
    PreCompact: [{ hooks: [{ type: "command", command: "echo compact" }] }],
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-pet-settings-"));
  file = join(dir, "settings.json");
});

const write = (data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const read = () => JSON.parse(readFileSync(file, "utf8"));

describe("installHooks", () => {
  it("adds every event in the block", () => {
    write(USER_SETTINGS);
    const { events } = installHooks(block(), PORT, file);
    expect(events).toHaveLength(11);
    expect(Object.keys(read().hooks).sort()).toEqual(
      [...new Set([...events, "PreCompact"])].sort(),
    );
  });

  it("preserves unrelated user hooks, including on events we also use", () => {
    write(USER_SETTINGS);
    installHooks(block(), PORT, file);
    const stop = read().hooks.Stop;
    // Ours is appended; theirs stays first and untouched.
    expect(stop[0].hooks[0].command).toBe("echo mine");
    expect(stop.some((e: { hooks: { url?: string }[] }) => e.hooks[0]?.url === ourUrl(PORT))).toBe(
      true,
    );
    expect(read().hooks.PreCompact[0].hooks[0].command).toBe("echo compact");
  });

  it("keeps unrelated top-level settings", () => {
    write(USER_SETTINGS);
    installHooks(block(), PORT, file);
    expect(read().model).toBe("opus");
  });

  it("is idempotent across three runs", () => {
    write(USER_SETTINGS);
    installHooks(block(), PORT, file);
    const once = readFileSync(file, "utf8");
    installHooks(block(), PORT, file);
    installHooks(block(), PORT, file);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("creates the hooks object when the file has none", () => {
    write({ model: "opus" });
    installHooks(block(), PORT, file);
    expect(Object.keys(read().hooks)).toHaveLength(11);
  });

  it("works when the file does not exist at all", () => {
    installHooks(block(), PORT, file);
    expect(Object.keys(read().hooks)).toHaveLength(11);
  });

  it("backs the file up before writing, and only when there is something to back up", () => {
    write(USER_SETTINGS);
    const { backup } = installHooks(block(), PORT, file);
    expect(backup).toMatch(/settings\.json\.bak-/);
    expect(JSON.parse(readFileSync(backup as string, "utf8"))).toEqual(USER_SETTINGS);
    expect(readdirSync(dir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });
});

describe("uninstallHooks", () => {
  it("restores the file byte-identically", () => {
    write(USER_SETTINGS);
    const before = readFileSync(file, "utf8");
    installHooks(block(), PORT, file);
    uninstallHooks(PORT, file);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("removes only our entries and reports the count", () => {
    write(USER_SETTINGS);
    installHooks(block(), PORT, file);
    const { removed } = uninstallHooks(PORT, file);
    expect(removed).toBe(11);
    expect(read().hooks.Stop).toHaveLength(1);
    expect(read().hooks.Stop[0].hooks[0].command).toBe("echo mine");
  });

  it("identifies our entries by URL, not by position", () => {
    write(USER_SETTINGS);
    installHooks(block(), PORT, file);
    // Simulate the user editing the file between install and uninstall.
    const s = read();
    s.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo added later" }] });
    s.hooks.Stop.push({ hooks: [{ type: "command", command: "echo also later" }] });
    write(s);

    uninstallHooks(PORT, file);
    const commands = read().hooks.Stop.map(
      (e: { hooks: { command?: string }[] }) => e.hooks[0]?.command,
    );
    expect(commands).toEqual(["echo added later", "echo mine", "echo also later"]);
  });

  it("leaves a different port's entries alone", () => {
    installHooks(block(), PORT, file);
    const { removed } = uninstallHooks(59999, file);
    expect(removed).toBe(0);
    expect(Object.keys(read().hooks)).toHaveLength(11);
  });

  it("drops the hooks object entirely if we were the only thing in it", () => {
    write({ model: "opus" });
    installHooks(block(), PORT, file);
    uninstallHooks(PORT, file);
    expect(read()).toEqual({ model: "opus" });
  });

  it("is a no-op on a file that was never installed into", () => {
    write(USER_SETTINGS);
    const before = readFileSync(file, "utf8");
    expect(uninstallHooks(PORT, file).removed).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("is a no-op when the file does not exist", () => {
    expect(uninstallHooks(PORT, join(dir, "nope.json")).removed).toBe(0);
  });
});

describe("hooksBlock", () => {
  it("covers the eleven events in spec §5.3", () => {
    expect(Object.keys(hooksBlock(PORT) as object)).toEqual([
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PermissionDenied",
      "Notification",
      "Stop",
      "StopFailure",
    ]);
  });

  it("uses a short timeout — HTTP hooks are synchronous and the agent waits", () => {
    for (const entries of Object.values(
      hooksBlock(PORT) as Record<string, { hooks: { timeout: number }[] }[]>,
    )) {
      for (const e of entries) expect(e.hooks[0]?.timeout).toBeLessThanOrEqual(2);
    }
  });

  it("only sets a matcher on the tool events", () => {
    const b = hooksBlock(PORT) as Record<string, { matcher?: string }[]>;
    expect(b.PreToolUse?.[0]?.matcher).toBe(".*");
    expect(b.Stop?.[0]?.matcher).toBeUndefined();
  });
});

describe("hookConfig — what the tray puts on the clipboard", () => {
  it("names the endpoint it was given, and only that", () => {
    const text = claudeCodeAdapter.hookConfig?.("http://127.0.0.1:48999/event/claude-code") ?? "";
    expect(text).toContain("48999");
    expect(text).not.toContain("48200");
  });

  it("is valid JSON covering the eleven events in §5.3", () => {
    const parsed = JSON.parse(claudeCodeAdapter.hookConfig?.("http://x/e") ?? "{}");
    expect(Object.keys(parsed.hooks)).toHaveLength(11);
  });

  it("matches the plugin block this repo ships", () => {
    // Two copies of the same configuration would drift; this is the tripwire.
    const generated = JSON.parse(claudeCodeAdapter.hookConfig?.(ourUrl(48200)) ?? "{}");
    const shipped = JSON.parse(
      readFileSync(new URL("../plugin/hooks/hooks.json", import.meta.url), "utf8"),
    );
    expect(Object.keys(generated.hooks).sort()).toEqual(Object.keys(shipped.hooks).sort());
    for (const event of Object.keys(shipped.hooks)) {
      expect(generated.hooks[event], event).toEqual(shipped.hooks[event]);
    }
  });

  it("keeps every timeout short — HTTP hooks are synchronous (I2)", () => {
    const parsed = JSON.parse(claudeCodeAdapter.hookConfig?.("http://x/e") ?? "{}");
    for (const [event, entries] of Object.entries(parsed.hooks)) {
      for (const entry of entries as { hooks: { timeout: number }[] }[]) {
        expect(entry.hooks[0]?.timeout, event).toBeLessThanOrEqual(2);
      }
    }
  });
});
