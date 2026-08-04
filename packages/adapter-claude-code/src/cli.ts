import { resolve } from "node:path";
import { claudeCodeAdapter, commandHookConfig } from "./mapping.ts";
import { startRecorder } from "./record.ts";
import {
  installedEvents,
  installHooks,
  ourUrl,
  pluginInstalled,
  SETTINGS_PATH,
  uninstallHooks,
} from "./settings.ts";

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

/**
 * The one place a hook block comes from.
 *
 * There used to be a second, hand-written copy here for the install path — the
 * exact thing `scripts/generate-hooks-json.mjs` was added to prevent, sitting
 * in the path that milestone shipped. The drift check only compared the
 * adapter against the plugin file, so this copy was never covered by it.
 */
function hooksFor(port: number, style: "http" | "command" = "http"): Record<string, unknown[]> {
  const url = ourUrl(port);
  const text =
    style === "command" ? commandHookConfig(url) : (claudeCodeAdapter.hookConfig?.(url) ?? "{}");
  return (JSON.parse(text) as { hooks?: Record<string, unknown[]> }).hooks ?? {};
}

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
  // Command hooks exist for one reason: an http hook that cannot connect makes
  // Claude Code print two lines per tool call, and stopping the pet is an
  // ordinary thing to do. See commandHookConfig.
  const style = argv.includes("--command") ? "command" : "http";
  if (style === "command" && process.platform === "win32") {
    console.error("--command is POSIX-only: the shell it generates is sh, not powershell.");
    console.error("A powershell equivalent is untested here, and an untested hook that");
    console.error("breaks every tool call is worse than the noise it would remove.");
    return 1;
  }
  const { backup, events } = installHooks(hooksFor(port, style), port);
  console.log(`installed ${events.length} hook events into ${SETTINGS_PATH}`);
  console.log(`  endpoint: ${ourUrl(port)}`);
  console.log(
    style === "command"
      ? "  style:    command — silent when the pet is not running"
      : "  style:    http — prints a hook error per tool call when the pet is down",
  );
  console.log(backup ? `  backup:   ${backup}` : "  backup:   none (file did not exist)");
  const portArg = port === DEFAULT_PORT ? "" : ` --port ${port}`;
  console.log(`\nRemove with: pet-adapter uninstall${portArg}`);
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

/**
 * Diagnose, rather than print.
 *
 * The three ways this setup fails are all silent: the pet is not running, the
 * hooks are not installed, or they point at a port nothing is listening on.
 * None of them produce an error anywhere — the pet simply never reacts — so the
 * only useful thing a doctor can do is check each one and say which it is.
 */
async function cmdDoctor(argv: readonly string[]): Promise<number> {
  const port = portFrom(argv, DEFAULT_PORT);
  const url = ourUrl(port);
  let healthy = false;
  let reported: unknown;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    healthy = res.ok;
    reported = await res.json();
  } catch {
    healthy = false;
  }

  const installed = installedEvents(port);
  const plugin = pluginInstalled();

  console.log(`endpoint  ${url}`);
  console.log(
    `pet       ${healthy ? "running" : "NOT running — start Agent Pet, or hooks will do nothing"}`,
  );
  if (healthy && reported && typeof reported === "object") {
    const h = reported as { webview?: { connected?: boolean; sessions?: number } };
    console.log(
      `          webview ${h.webview?.connected ? "connected" : "NOT connected"}, ` +
        `${h.webview?.sessions ?? 0} session(s)`,
    );
  }
  console.log(
    `plugin    ${plugin ? "installed" : "not installed  (/plugin install agent-pet@trizenx)"}`,
  );
  console.log(
    `hooks     ${
      installed.length > 0
        ? `${installed.length}/${Object.keys(hooksFor(port)).length} events in ${SETTINGS_PATH}`
        : `none in ${SETTINGS_PATH}`
    }`,
  );

  if (!plugin && installed.length === 0) {
    console.log("\nNothing is wired up. Either:");
    console.log("  /plugin install agent-pet@trizenx        (recommended)");
    console.log(`  pet-adapter install${port === DEFAULT_PORT ? "" : ` --port ${port}`}`);
  } else if (plugin && installed.length > 0) {
    console.log("\nBoth paths are active. Harmless — each event just arrives twice — but");
    console.log("`pet-adapter uninstall` will leave only the plugin.");
  } else if (!healthy) {
    console.log("\nHooks are wired but nothing is listening. Start the pet, or if it is");
    console.log("running on another port, reinstall the hooks with --port.");
  } else {
    // Set up and working. Saying nothing here, and then printing a block to
    // paste, read as though work remained — which is the one question this
    // command exists to answer.
    console.log("\nSet up. New sessions will drive the pet; this one keeps whatever");
    console.log("hooks it started with.");
  }

  // §5.4 asks doctor for two things: which path is active, and the correct
  // block for the current port. The rewrite delivered the first and dropped
  // the second — while the plugin README it shipped alongside told users to
  // run `doctor --port N` precisely to get the block. Printing it is also the
  // whole answer for a non-default port, which is the case D9 refuses to
  // paper over.
  //
  // Not printed when everything is already wired, though: an unasked-for block
  // of configuration under a green report is an instruction, and there is
  // nothing left to do.
  const wired = healthy && (plugin || installed.length > 0);
  if (!wired || port !== DEFAULT_PORT) {
    console.log("\nHooks for this port — paste into the `hooks` object of that file:\n");
    console.log(claudeCodeAdapter.hookConfig?.(ourUrl(port)) ?? "");
  }

  return healthy && (plugin || installed.length > 0) ? 0 : 1;
}

function cmdRecord(argv: readonly string[]): number {
  const port = portFrom(argv, RECORD_PORT);
  const outDir = resolve(flag(argv, "out") ?? "test/fixtures");
  const install = argv.includes("--install");
  const redactPayloads = !argv.includes("--no-redact");
  const only = new Set(
    (flag(argv, "only") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const force = argv.includes("--force");

  if (install) {
    const { backup } = installHooks(hooksFor(port), port);
    console.log(`[record] hooks installed (backup: ${backup ?? "none"})`);
    console.log("[record] they will be removed on exit\n");
  }

  const server = startRecorder({ port, outDir, redactPayloads, verbose: true, only, force });

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

export function main(argv: readonly string[]): number | Promise<number> {
  switch (argv[0]) {
    case "install":
      return cmdInstall(argv);
    case "uninstall":
      return cmdUninstall(argv);
    case "doctor":
      // Returns a promise; the entry point below awaits it.
      return cmdDoctor(argv);
    case "record":
      return cmdRecord(argv);
    default:
      console.error(`usage: pet-adapter <${COMMANDS.join("|")}> [--port N] [--out DIR]`);
      console.error(
        "       pet-adapter record --install          # temporary hooks, removed on exit",
      );
      console.error("       pet-adapter record --only A,B         # capture only these hooks");
      console.error("       pet-adapter record --force            # replace fixtures that exist");
      console.error(
        "       pet-adapter install --command        # hooks that stay quiet with no pet",
      );
      return 1;
  }
}

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  const code = await main(process.argv.slice(2));
  // `record` keeps the event loop alive on purpose; everything else exits.
  if (process.argv[2] !== "record") process.exit(code);
}
