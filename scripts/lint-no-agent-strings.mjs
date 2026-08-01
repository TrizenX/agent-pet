#!/usr/bin/env node
/**
 * Enforces invariant I5: pet-core contains zero hardcoded agent knowledge.
 *
 * Exactly one file — src/adapters/registry.ts — may name an adapter. Anything
 * else mentioning an agent, a tool name, or a hook event name means Phase 2
 * has stopped being a pure addition.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = join(ROOT, "packages/pet-core/src");
const ALLOWED = new Set(["adapters/registry.ts"]);

/** Strings that would mean agent knowledge has leaked out of the adapter. */
const FORBIDDEN = [
  { pattern: /\bclaude\b/i, label: "agent name" },
  { pattern: /\bcodex\b/i, label: "agent name" },
  {
    pattern:
      /\b(PreToolUse|PostToolUse|SessionStart|SessionEnd|UserPromptSubmit|StopFailure|PermissionRequest|PermissionDenied)\b/,
    label: "hook event name",
  },
  { pattern: /\b(BashOutput|MultiEdit|NotebookEdit|WebFetch|WebSearch)\b/, label: "tool name" },
  { pattern: /\.claude\b/, label: "agent config path" },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

let failures = 0;
for (const file of walk(SCAN)) {
  const rel = relative(SCAN, file).split(sep).join("/");
  if (ALLOWED.has(rel)) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(line)) {
        console.error(
          `I5 violation  packages/pet-core/src/${rel}:${i + 1}  (${label})\n    ${line.trim()}`,
        );
        failures++;
      }
    }
  });
}

if (failures > 0) {
  console.error(
    `\n${failures} violation(s). Agent-specific knowledge belongs in an adapter package.\n` +
      `If this is a legitimate new registration point, add it to ALLOWED in ${relative(ROOT, new URL(import.meta.url).pathname)}.`,
  );
  process.exit(1);
}
console.log("I5 ok — pet-core names no agent outside adapters/registry.ts");
