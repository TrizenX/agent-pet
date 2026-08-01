/**
 * `pet-adapter` CLI — install | uninstall | doctor | record.
 *
 * M2 work. Distribution is plugin-first (D4): `plugin/hooks/hooks.json` is the
 * primary path and needs no CLI at all. This binary exists for users who would
 * rather merge hooks into ~/.claude/settings.json by hand, plus `record`, which
 * captures live hook payloads as test fixtures (§11.1).
 *
 * Deliberately unimplemented until M2 so that nothing in the repo pretends to
 * write to a user's settings file before the merge logic is tested.
 */

const COMMANDS = ["install", "uninstall", "doctor", "record"] as const;

export function main(argv: readonly string[]): number {
  const cmd = argv[0];
  if (cmd && (COMMANDS as readonly string[]).includes(cmd)) {
    console.error(`pet-adapter ${cmd}: not implemented yet (M2).`);
    return 2;
  }
  console.error(`usage: pet-adapter <${COMMANDS.join("|")}>`);
  return 1;
}
