#!/usr/bin/env node
/**
 * Enforces invariant I5: pet-core contains zero hardcoded agent knowledge.
 *
 * One file may name an adapter — src/adapters/registry.ts — plus the one test
 * that proves the registry wires it. Anything else mentioning an agent, a tool
 * name, or a hook event name means Phase 2 has stopped being a pure addition.
 *
 * Scans the Rust shell as well as the TypeScript. It did not, once, and a code
 * review found the shell generating hook configuration with all eleven event
 * names in it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
// Both halves of pet-core. The Rust shell was exempt until a code review found
// eleven hook event names and an agent id sitting in it, invisible to this
// check — the gap in the enforcement was worse than the violation.
const SCAN_ROOTS = [
  { dir: join(ROOT, "packages/pet-core/src"), label: "packages/pet-core/src" },
  { dir: join(ROOT, "packages/pet-core/src-tauri/src"), label: "packages/pet-core/src-tauri/src" },
];
const ALLOWED = new Set([
  "adapters/registry.ts",
  // Proving the registry actually wires an adapter means naming one. Same
  // category as the registry itself, and deliberately not a blanket exemption
  // for tests — the rule already caught an agent name in a machine test
  // comment, which was a real smell.
  "pipeline.test.ts",
  // Same category, same reason. `App.test.tsx` drives a raw hook payload all
  // the way to the DOM — that is the point of it, after the joins between
  // adapter, machine and renderer turned out to be where every bug lived — and
  // a real payload cannot be written without naming a real hook.
  //
  // Whole-file rather than per-string, unlike `packs.rs` below, because the
  // strings here are the test's subject rather than an incidental path.
  "App.test.tsx",
]);

/**
 * Lines that are allowed to match, keyed by file.
 *
 * Scoped to a substring rather than a whole file. `packs.rs` needs to name an
 * install root — `~/.codex/pets` names a tool, but it is an *art* location, not
 * agent knowledge: the list would be identical whether we supported zero
 * adapters or ten. Exempting the whole file to say that would also blind the
 * check to every other forbidden string anyone adds to it later, which is the
 * shape of the gap this script exists to close.
 */
const ALLOWED_LINES = new Map([["packs.rs", [".codex/pets", '"codex".to_string()']]]);

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
    else if (/\.(ts|tsx|rs)$/.test(name)) yield full;
  }
}

let failures = 0;
for (const root of SCAN_ROOTS) {
  for (const file of walk(root.dir)) {
    const rel = relative(root.dir, file).split(sep).join("/");
    if (ALLOWED.has(rel)) continue;

    const exempt = ALLOWED_LINES.get(rel) ?? [];
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (exempt.some((s) => line.includes(s))) return;
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) {
          console.error(
            `I5 violation  ${root.label}/${rel}:${i + 1}  (${label})\n    ${line.trim()}`,
          );
          failures++;
        }
      }
    });
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} violation(s). Agent-specific knowledge belongs in an adapter package.\n` +
      `If this is a legitimate new registration point, add it to ALLOWED in ${relative(ROOT, new URL(import.meta.url).pathname)}.`,
  );
  process.exit(1);
}
console.log("I5 ok — pet-core names no agent outside adapters/registry.ts");
