import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/mapping.ts";
import {
  installedEvents,
  installHooks,
  ourUrl,
  pluginInstalled,
  uninstallHooks,
} from "../src/settings.ts";

const PORT = 48200;
const block = () =>
  (
    JSON.parse(claudeCodeAdapter.hookConfig?.(ourUrl(PORT)) ?? "{}") as {
      hooks: Record<string, unknown[]>;
    }
  ).hooks;

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
    expect(events).toHaveLength(13);
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
    expect(Object.keys(read().hooks)).toHaveLength(13);
  });

  it("works when the file does not exist at all", () => {
    installHooks(block(), PORT, file);
    expect(Object.keys(read().hooks)).toHaveLength(13);
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
    expect(removed).toBe(13);
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
    expect(Object.keys(read().hooks)).toHaveLength(13);
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

describe("installedEvents — what doctor reports", () => {
  it("lists nothing before install and everything after", () => {
    write(USER_SETTINGS);
    expect(installedEvents(PORT, file)).toEqual([]);
    installHooks(block(), PORT, file);
    expect(installedEvents(PORT, file)).toHaveLength(13);
  });

  it("ignores the user's own hooks on the same events", () => {
    // USER_SETTINGS has a Stop hook of its own; it must not count as ours.
    write(USER_SETTINGS);
    expect(installedEvents(PORT, file)).toEqual([]);
  });

  it("does not see another port's install", () => {
    installHooks(block(), PORT, file);
    expect(installedEvents(59999, file)).toEqual([]);
  });

  it("survives a corrupt or missing file", () => {
    writeFileSync(file, "{ not json");
    expect(installedEvents(PORT, file)).toEqual([]);
    expect(installedEvents(PORT, join(dir, "nope.json"))).toEqual([]);
  });
});

describe("pluginInstalled", () => {
  it("is true only when the plugin is enabled", () => {
    write({ enabledPlugins: { "agent-pet@trizenx": true } });
    expect(pluginInstalled(file)).toBe(true);

    // Installed but switched off sends no hooks, which is the question a user
    // asking why their pet is idle actually has.
    write({ enabledPlugins: { "agent-pet@trizenx": false } });
    expect(pluginInstalled(file)).toBe(false);
  });

  it("is not confused by other plugins", () => {
    write({ enabledPlugins: { "something-else@vendor": true } });
    expect(pluginInstalled(file)).toBe(false);
  });

  it("survives a corrupt or missing file", () => {
    writeFileSync(file, "nonsense");
    expect(pluginInstalled(file)).toBe(false);
    expect(pluginInstalled(join(dir, "nope.json"))).toBe(false);
  });
});
