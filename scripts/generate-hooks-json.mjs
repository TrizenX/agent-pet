#!/usr/bin/env node
/**
 * Regenerate the plugin's hooks.json from the adapter.
 *
 * The adapter already composes this block for the tray's Copy hook config, and
 * two hand-maintained copies of the same configuration drift — one of them
 * quietly stops matching the endpoint the app actually listens on, and the
 * symptom is a pet that never reacts.
 *
 *   node scripts/generate-hooks-json.mjs           # write
 *   node scripts/generate-hooks-json.mjs --check   # fail if stale (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/src/mapping.ts";

const DEFAULT_PORT = 48200;
const OUT = join(
  new URL("..", import.meta.url).pathname,
  "packages/adapter-claude-code/plugin/hooks/hooks.json",
);

const endpoint = `http://127.0.0.1:${DEFAULT_PORT}/event/${claudeCodeAdapter.id}`;
const generated = `${claudeCodeAdapter.hookConfig?.(endpoint) ?? ""}\n`;

if (process.argv.includes("--check")) {
  const onDisk = readFileSync(OUT, "utf8");
  if (onDisk !== generated) {
    console.error(
      `${OUT} is stale.\nRun: node scripts/generate-hooks-json.mjs\n\n` +
        "The plugin ships a copy of what the adapter generates; they must not diverge.",
    );
    process.exit(1);
  }
  console.log("hooks.json matches the adapter");
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${OUT}`);
}
