/**
 * The wire contract between any agent adapter and the pet runtime.
 *
 * Invariant I7: every event carries `v` and `source`. Phase 3 turns this file
 * into a public protocol; unversioned protocols die.
 */

export const PET_EVENT_VERSION = 1;

export type ToolKind =
  | "bash"
  | "file_edit"
  | "file_read"
  | "search"
  | "network"
  | "delegate"
  | "other";

export type BlockReason =
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "auth"
  | "invalid_request"
  | "unknown";

export interface PetEventMeta {
  readonly v: typeof PET_EVENT_VERSION;
  /** Adapter id, e.g. "claude-code". Also the URL path segment: POST /event/<source> */
  readonly source: string;
  /** Stable per agent session. Required — the focus policy is built on it. */
  readonly sessionId: string;
  /** basename(cwd); shown in the bubble when more than one session is live. */
  readonly project?: string;
  /** Epoch ms, stamped by the receiver. Adapters are pure and never read a clock. */
  readonly at: number;
}

export type PetEventBody =
  | { type: "SESSION_START" }
  | { type: "SESSION_END" }
  | { type: "PROMPT_SUBMITTED" }
  | { type: "TOOL_START"; tool: ToolKind; label?: string }
  | { type: "TOOL_DONE"; ok: boolean; tool: ToolKind }
  | { type: "APPROVAL_NEEDED"; tool?: ToolKind; label?: string }
  | { type: "APPROVAL_RESOLVED"; granted: boolean }
  | { type: "AGENT_IDLE" }
  /**
   * One assistant turn ended. A *fact*, not an achievement — `Stop` fires on
   * every turn. Whether it deserves a celebration is policy, decided by the
   * `celebrationWorthy` guard. See spec §6.1.
   */
  | { type: "TURN_END" }
  | { type: "AGENT_BLOCKED"; reason: BlockReason }
  // Reserved for Phase 1.5. Accepted and ignored in Phase 1.
  | { type: "SUBAGENT_START"; agentType?: string }
  | { type: "SUBAGENT_END" };

export type PetEvent = PetEventMeta & PetEventBody;

export type PetEventType = PetEventBody["type"];

const KNOWN_TYPES: ReadonlySet<string> = new Set<PetEventType>([
  "SESSION_START",
  "SESSION_END",
  "PROMPT_SUBMITTED",
  "TOOL_START",
  "TOOL_DONE",
  "APPROVAL_NEEDED",
  "APPROVAL_RESOLVED",
  "AGENT_IDLE",
  "TURN_END",
  "AGENT_BLOCKED",
  "SUBAGENT_START",
  "SUBAGENT_END",
]);

/**
 * Structural validation for events arriving over the wire.
 *
 * Deliberately permissive about unknown *fields* and strict about the shape we
 * dispatch on. Unknown `type` or `v` values must be dropped, never thrown on
 * (spec §6.2) — forward compatibility is a protocol requirement.
 */
export function isPetEvent(value: unknown): value is PetEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === PET_EVENT_VERSION &&
    typeof e.source === "string" &&
    e.source.length > 0 &&
    typeof e.sessionId === "string" &&
    e.sessionId.length > 0 &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    typeof e.type === "string" &&
    KNOWN_TYPES.has(e.type)
  );
}
