#!/usr/bin/env node
/**
 * Every declared export points at a file that exists.
 *
 * `adapter-git` shipped with an `./install` export naming a file that was never
 * written. Nothing imported it, so nothing failed — the package simply
 * advertised an entry point that would explode the first time anyone used it.
 *
 * Same shape as three other defects this project has had: `nextState` froze the
 * pet mid-jump for a milestone, `label` sat unused in the wire format since M0,
 * and the `sleeping` strings outlived the code that read them. Config that
 * reads like a decision and does nothing is worse than none, because it stops
 * anyone looking.
 */
import { existsSync, globSync, readFileSync } from "node:fs";

let missing = 0;
for (const manifest of globSync("packages/*/package.json")) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const [name, target] of Object.entries(pkg.exports ?? {})) {
    const full = manifest.replace(/package\.json$/, "") + String(target).replace(/^\.\//, "");
    if (!existsSync(full)) {
      console.error(`  ${pkg.name} exports ${name} -> ${target}  (no such file)`);
      missing += 1;
    }
  }
}

if (missing > 0) {
  console.error(`\n${missing} declared export(s) point at nothing.`);
  process.exit(1);
}
console.log("exports ok — every declared entry point exists");
