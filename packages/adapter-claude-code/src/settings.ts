import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Merge our hooks into an agent's settings file, and take them out again.
 *
 * Plugin distribution (D4) is the primary path and needs none of this. It
 * exists for users who would rather not install a plugin, and for
 * `pet-adapter record`, which has to install hooks temporarily.
 *
 * Two rules, because this file belongs to the user and not to us:
 *   1. Merge, never overwrite. Unrelated hooks survive untouched.
 *   2. Identify our entries by URL, never by position — the user will edit
 *      this file between our install and our uninstall.
 */

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export function ourUrl(port: number): string {
  return `http://127.0.0.1:${port}/event/claude-code`;
}

type Json = Record<string, unknown>;

/**
 * Whether this entry is one of ours, for the given endpoint.
 *
 * Matches both hook shapes. An `http` hook carries the endpoint in `url`; a
 * `command` hook carries it inside the shell command, and matching only on `url`
 * meant `uninstall` silently walked past every command hook — leaving them behind
 * for `install` to duplicate. The endpoint is the identity in both cases, so it
 * is the thing to look for wherever it appears.
 */
function isOurs(entry: unknown, urlPrefix: string): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const url = (h as { url?: unknown })?.url;
    if (typeof url === "string" && url.startsWith(urlPrefix)) return true;
    const command = (h as { command?: unknown })?.command;
    return typeof command === "string" && command.includes(urlPrefix);
  });
}

export function backup(path = SETTINGS_PATH): string | null {
  if (!existsSync(path)) return null;
  // Colons are legal on macOS but confuse enough tools to be worth avoiding.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.bak-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

function read(path: string): Json {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function write(path: string, data: Json): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Idempotent: running it three times leaves the file identical to running it
 * once, because our own entries are removed before the new ones are added.
 */
export function installHooks(
  block: Record<string, unknown[]>,
  port: number,
  path = SETTINGS_PATH,
): { backup: string | null; events: string[] } {
  const saved = backup(path);
  const settings = read(path);
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};
  const url = ourUrl(port);

  for (const [event, entries] of Object.entries(block)) {
    const existing = (hooks[event] ?? []).filter((e) => !isOurs(e, url));
    hooks[event] = [...existing, ...entries];
  }

  settings.hooks = hooks;
  write(path, settings);
  return { backup: saved, events: Object.keys(block) };
}

/** Removes only entries whose URL is ours, and prunes events left empty. */
export function uninstallHooks(port: number, path = SETTINGS_PATH): { removed: number } {
  if (!existsSync(path)) return { removed: 0 };
  const settings = read(path);
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return { removed: 0 };

  const url = ourUrl(port);
  let removed = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries.filter((e) => {
      const mine = isOurs(e, url);
      if (mine) removed++;
      return !mine;
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  // Leave no empty `hooks: {}` behind if we were the only thing in it.
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;

  write(path, settings);
  return { removed };
}

/** Which of our hook events are currently present in the settings file. */
export function installedEvents(port: number, path = SETTINGS_PATH): string[] {
  if (!existsSync(path)) return [];
  let settings: Json;
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return [];
  }
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return [];
  const url = ourUrl(port);
  return Object.entries(hooks)
    .filter(([, entries]) => entries.some((e) => isOurs(e, url)))
    .map(([event]) => event);
}

/**
 * Whether the plugin is enabled for this user.
 *
 * Read from the same settings file rather than by scanning the plugin cache:
 * an installed-but-disabled plugin sends no hooks, and "installed" is not the
 * question a user asking why their pet is idle actually has.
 */
export function pluginInstalled(path = SETTINGS_PATH): boolean {
  if (!existsSync(path)) return false;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as Json;
    const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
    return Object.entries(enabled ?? {}).some(([key, on]) => on && key.startsWith("agent-pet@"));
  } catch {
    return false;
  }
}
