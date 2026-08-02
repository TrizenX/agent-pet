#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_HOOKS, gitAdapter } from "./mapping.ts";

/**
 * Writing git hooks into a repository.
 *
 * The counterpart to `pet-adapter install`, and a different job: an agent's
 * hooks are configuration you merge into a settings file, git's are executable
 * files you place in a directory. `PetAdapter.hookConfig` returns a script that
 * does this, which is fine to read and awkward to run; this does it.
 *
 * Per repository, because that is where git hooks live. There is no global
 * equivalent short of `core.hooksPath`, which would take over hooks for every
 * repository on the machine — too much to do on someone's behalf.
 */

const MARKER = "# agent-pet";
const DEFAULT_PORT = 48200;

function script(endpoint: string, hook: string): string {
  // Backgrounded and capped at two seconds, for the same reason the agent's
  // hooks are: a pet that is not running must cost a commit nothing, and a pet
  // that is wedged must not hold one open (I2).
  return `#!/bin/sh
${MARKER} — remove this file to disconnect
curl -sm2 -XPOST -H 'content-type: application/json' \\
  -d "{\\"event\\":\\"${hook}\\",\\"repo\\":\\"$(git rev-parse --show-toplevel)\\",\\"branch\\":\\"$(git branch --show-current)\\"}" \\
  ${endpoint} >/dev/null 2>&1 &
exit 0
`;
}

export interface InstallResult {
  readonly written: readonly string[];
  /** Hooks left alone because someone else's script is already there. */
  readonly skipped: readonly string[];
}

/**
 * Never overwrites a hook we did not write.
 *
 * A pre-commit hook is often the only thing standing between a repository and a
 * bad commit. Replacing one to show a cartoon would be an unforgivable trade,
 * so an existing script without our marker is left exactly as it is and
 * reported.
 */
export function installGitHooks(repoRoot: string, endpoint: string): InstallResult {
  const dir = join(repoRoot, ".git", "hooks");
  if (!existsSync(dir)) throw new Error(`${repoRoot} has no .git/hooks — is it a repository?`);

  const written: string[] = [];
  const skipped: string[] = [];
  for (const hook of GIT_HOOKS) {
    const path = join(dir, hook);
    if (existsSync(path) && !readFileSync(path, "utf8").includes(MARKER)) {
      skipped.push(hook);
      continue;
    }
    writeFileSync(path, script(endpoint, hook));
    chmodSync(path, 0o755);
    written.push(hook);
  }
  return { written, skipped };
}

/** Removes only what we wrote. */
export function uninstallGitHooks(repoRoot: string): { removed: readonly string[] } {
  const dir = join(repoRoot, ".git", "hooks");
  const removed: string[] = [];
  for (const hook of GIT_HOOKS) {
    const path = join(dir, hook);
    if (existsSync(path) && readFileSync(path, "utf8").includes(MARKER)) {
      writeFileSync(path, "");
      chmodSync(path, 0o644);
      removed.push(hook);
    }
  }
  return { removed };
}

function main(argv: readonly string[]): number {
  const repo = process.cwd();
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : DEFAULT_PORT;
  const endpoint = `http://127.0.0.1:${port}/event/${gitAdapter.id}`;

  if (argv[0] === "uninstall") {
    const { removed } = uninstallGitHooks(repo);
    console.log(
      removed.length
        ? `removed ${removed.length} hook(s) from ${repo}`
        : "nothing of ours to remove",
    );
    return 0;
  }
  if (argv[0] !== "install") {
    console.error("usage: pet-git <install|uninstall> [--port N]   (run inside a repository)");
    return 1;
  }

  const { written, skipped } = installGitHooks(repo, endpoint);
  console.log(`wrote ${written.length} hook(s) into ${repo}/.git/hooks`);
  console.log(`  endpoint: ${endpoint}`);
  if (skipped.length > 0) {
    console.log(`\nleft alone (a hook is already there and is not ours): ${skipped.join(", ")}`);
    console.log("Nothing is worth replacing someone's pre-commit hook for.");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
