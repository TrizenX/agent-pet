import { claudeCodeAdapter } from "@agent-pet/adapter-claude-code/mapping";
import type { PetAdapter } from "@agent-pet/protocol";

/**
 * ⚠️  INVARIANT I5 — this is the ONLY file in pet-core allowed to name an
 * adapter. Nothing else may contain an agent's name, a tool name, or a hook
 * event name. `pnpm lint:no-agent-strings` enforces it.
 *
 * Adding an agent in Phase 2 is one line here and nothing else.
 */
export const ADAPTERS: readonly PetAdapter[] = [claudeCodeAdapter];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

export function adapterFor(source: string): PetAdapter | undefined {
  return BY_ID.get(source);
}
