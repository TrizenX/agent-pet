import type { PetEvent } from "./events.ts";

export interface AdapterContext {
  /** Epoch ms stamped by the receiver. Passed in so adapters stay pure. */
  readonly receivedAt: number;
}

/**
 * Translates one agent's raw hook payloads into PetEvents.
 *
 * `toPetEvents` MUST be pure: no I/O, no clock, no randomness. Purity is what
 * makes the mapping table-testable against payloads recorded from a live agent
 * (spec §11.1), which is the only defence against a hook schema that keeps
 * evolving.
 */
export interface PetAdapter {
  /** Stable id; also the URL path segment: POST /event/<id> */
  readonly id: string;
  /** Human-readable; shown in the tray and in /health */
  readonly label: string;
  /** May return zero, one, or several events. Never throws. */
  toPetEvents(raw: unknown, ctx: AdapterContext): PetEvent[];

  /**
   * The configuration a user pastes into this agent's settings to point its
   * hooks at `endpoint`.
   *
   * Lives on the adapter because it is the only thing that knows what this
   * agent's hooks are called. Optional: an adapter for something that does not
   * use hooks has nothing to offer here.
   */
  hookConfig?(endpoint: string): string;
}
