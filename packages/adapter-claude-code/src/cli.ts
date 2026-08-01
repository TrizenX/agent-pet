import { resolve } from "node:path";
import { hooksBlock, startRecorder } from "./record.ts";
import { installHooks, ourUrl, SETTINGS_PATH, uninstallHooks } from "./settings.ts";

/**
 * `pet-adapter` — install | uninstall | doctor | record.
 *
 * Distribution is plugin-first (D4): `plugin/hooks/hooks.json` is the primary
 * path and needs no CLI at all. This binary is the fallback for users who
 * would rather not install a plugin, plus `record`, which captures live hook
 * payloads as test fixtures (§11.1) and has to install hooks temporarily to do
 * its job.
 */

const DEFAULT_PORT = 48200;
const RECORD_PORT = 48201;

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function portFrom(argv: readonly string[], fallback: number): number {
  const raw = flag(argv, "port") ?? process.env.PET_PORT;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function cmdInstall(argv: readonly string[]): number {
  const port = portFrom(argv, DEFAULT_PORT);
  const { backup, events } = installHooks(hooksBlock(port) as Record<string, unknown[]>, port);
  console.log(`installed ${events.length} hook events into ${SETTINGS_PATH}`);
  console.log(`  endpoint: ${ourUrl(port)}`);
  console.log(backup ? `  backup:   ${backup}` : "  backup:   none (file did not exist)");
  console.log(
    "\nRemove with: pet-adapter uninstall" + (port === DEFAULT_PORT ? "" : ` --port ${port}`),
  );
  return 0;
}

function cmdUninstall(argv: readonly string[]): number {
  const port = portFrom(argv, DEFAULT_PORT);
  const { removed } = uninstallHooks(port);
  console.log(
    removed === 0
      ? `no entries matching ${ourUrl(port)} in ${SETTINGS_PATH}`
      : `removed ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${SETTINGS_PATH}`,
  );
  return 0;
}

function cmdDoctor(argv: readonly string[]): number {
  const port = portFrom(argv, DEFAULT_PORT);
  console.log(`settings: ${SETTINGS_PATH}`);
  console.log(`endpoint: ${ourUrl(port)}`);
  console.log("\nPaste this into the `hooks` object if installing by hand:\n");
  console.log(JSON.stringify(hooksBlock(port), null, 2));
  return 0;
}

function cmdRecord(argv: readonly string[]): number {
  const port = portFrom(argv, RECORD_PORT);
  const outDir = resolve(flag(argv, "out") ?? "test/fixtures");
  const install = argv.includes("--install");
  const redactPayloads = !argv.includes("--no-redact");

  if (install) {
    const { backup } = installHooks(hooksBlock(port) as Record<string, unknown[]>, port);
    console.log(`[record] hooks installed (backup: ${backup ?? "none"})`);
    console.log("[record] they will be removed on exit\n");
  }

  const server = startRecorder({ port, outDir, redactPayloads, verbose: true });

  const shutdown = () => {
    server.close();
    if (install) {
      const { removed } = uninstallHooks(port);
      console.log(`\n[record] removed ${removed} hook entries`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

const COMMANDS = ["install", "uninstall", "doctor", "record"] as const;

export function main(argv: readonly string[]): number {
  switch (argv[0]) {
    case "install":
      return cmdInstall(argv);
    case "uninstall":
      return cmdUninstall(argv);
    case "doctor":
      return cmdDoctor(argv);
    case "record":
      return cmdRecord(argv);
    default:
      console.error(`usage: pet-adapter <${COMMANDS.join("|")}> [--port N] [--out DIR]`);
      console.error("       pet-adapter record --install   # temporary hooks, removed on exit");
      return 1;
  }
}

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  const code = main(process.argv.slice(2));
  // `record` keeps the event loop alive on purpose; everything else exits.
  if (process.argv[2] !== "record") process.exit(code);
}
