/**
 * Raw agent payload in, pet state out.
 *
 * The one place the three halves of the app meet: the adapter registry decides
 * what a payload *means*, the session registry decides *whose* it is, and the
 * focus policy decides which of them the single pet shows.
 *
 * Kept out of React so the whole path can be exercised in a test without
 * rendering anything.
 */

import { isPetEvent, type PetEvent } from "@agent-pet/protocol";
import { adapterFor } from "./adapters/registry.ts";
import type { SessionRegistry } from "./sessions/registry.ts";

/** What the shell forwards: a source tag and an unparsed body. */
export interface AgentRaw {
  readonly source: string;
  readonly payload: string;
  readonly at: number;
}

/** Source tag the shell uses for pre-normalised events (demo mode, tests). */
export const PRE_NORMALISED_SOURCE = "pet-event";

export interface IngestResult {
  readonly events: readonly PetEvent[];
  /** Why nothing came out, when nothing did. Feeds the event log. */
  readonly dropped?: "unparseable" | "unknown-source" | "not-a-pet-event" | "no-events";
}

/**
 * Parse and map one raw payload.
 *
 * Never throws. The shell answers `204` to anything (I1), which means anything
 * can arrive here — malformed JSON, a payload from an agent we do not support,
 * or a hook event this adapter has no opinion about. All three are ordinary.
 */
export function ingest(raw: AgentRaw): IngestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.payload);
  } catch {
    return { events: [], dropped: "unparseable" };
  }

  if (raw.source === PRE_NORMALISED_SOURCE) {
    // Bypasses the adapter registry on purpose: demo mode and third-party
    // integrators speak the wire format directly. Still validated, because
    // "pre-normalised" is a claim the sender makes, not a fact.
    return isPetEvent(parsed) ? { events: [parsed] } : { events: [], dropped: "not-a-pet-event" };
  }

  const adapter = adapterFor(raw.source);
  if (!adapter) return { events: [], dropped: "unknown-source" };

  const events = adapter.toPetEvents(parsed, { receivedAt: raw.at });
  return events.length > 0 ? { events } : { events: [], dropped: "no-events" };
}

/** Ingest, then route into the session registry. Returns what was produced. */
export function ingestInto(registry: SessionRegistry, raw: AgentRaw): IngestResult {
  const result = ingest(raw);
  for (const event of result.events) registry.handle(event);
  return result;
}
