import {
  type AdapterContext,
  type BlockReason,
  PET_EVENT_VERSION,
  type PetAdapter,
  type PetEvent,
  type PetEventBody,
} from "@agent-pet/protocol";
import { classifyTool } from "./tools.ts";

export const ADAPTER_ID = "claude-code";

/** Shape of the hook payloads we consume. Every field is treated as untrusted. */
interface RawHook {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  is_error?: unknown;
  notification_type?: unknown;
  reason?: unknown;
  error_type?: unknown;
}

function basename(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
}

const BLOCK_REASONS: Readonly<Record<string, BlockReason>> = {
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  billing_error: "billing",
  authentication_failed: "auth",
  invalid_request: "invalid_request",
  server_error: "unknown",
  max_output_tokens: "unknown",
  unknown: "unknown",
};

/** Pure. No I/O, no clock, no randomness — see PetAdapter's contract. */
function bodiesFor(raw: RawHook): PetEventBody[] {
  const event = raw.hook_event_name;
  const tool = classifyTool(raw.tool_name);

  switch (event) {
    case "SessionStart":
      return [{ type: "SESSION_START" }];
    case "SessionEnd":
      return [{ type: "SESSION_END" }];
    case "UserPromptSubmit":
      return [{ type: "PROMPT_SUBMITTED" }];

    case "PreToolUse":
      return [{ type: "TOOL_START", tool }];
    case "PostToolUse":
      // Spike B: `is_error` is documented but was never present in any recorded
      // payload — real failures arrive as `PostToolUseFailure` instead. Kept as
      // a defensive read so a future schema that does set it still works, and
      // pinned by a drift test in fixtures.test.ts.
      return [{ type: "TOOL_DONE", ok: raw.is_error !== true, tool }];
    case "PostToolUseFailure":
      return [{ type: "TOOL_DONE", ok: false, tool }];

    case "PermissionRequest":
      return [{ type: "APPROVAL_NEEDED", tool }];
    case "PermissionDenied":
      return [{ type: "APPROVAL_RESOLVED", granted: false }];

    case "Notification":
      switch (raw.notification_type) {
        case "permission_prompt":
          return [{ type: "APPROVAL_NEEDED" }];
        case "idle_prompt":
        case "agent_needs_input":
          return [{ type: "AGENT_IDLE" }];
        case "agent_completed":
          return [{ type: "TURN_END" }];
        default:
          // auth_success, elicitation_*, and anything added later: not ours.
          return [];
      }

    /**
     * `Stop` fires at the end of EVERY assistant turn, not when work is
     * finished. Emitting TASK_COMPLETE here would hoist a trophy every twenty
     * seconds and train the user to ignore it. We report the fact; the
     * `celebrationWorthy` guard decides what it means. Spec §6.1, D5.
     */
    case "Stop":
      return [{ type: "TURN_END" }];

    case "StopFailure": {
      const key = typeof raw.error_type === "string" ? raw.error_type : "unknown";
      return [{ type: "AGENT_BLOCKED", reason: BLOCK_REASONS[key] ?? "unknown" }];
    }

    default:
      return [];
  }
}

export const claudeCodeAdapter: PetAdapter = {
  id: ADAPTER_ID,
  label: "Claude Code",

  toPetEvents(rawInput: unknown, ctx: AdapterContext): PetEvent[] {
    if (typeof rawInput !== "object" || rawInput === null) return [];
    const raw = rawInput as RawHook;

    const sessionId = typeof raw.session_id === "string" ? raw.session_id : "";
    if (sessionId.length === 0) return [];

    const project = basename(raw.cwd);
    const meta = {
      v: PET_EVENT_VERSION,
      source: ADAPTER_ID,
      sessionId,
      at: ctx.receivedAt,
      ...(project === undefined ? {} : { project }),
    } as const;

    return bodiesFor(raw).map((body) => ({ ...meta, ...body }));
  },
};
