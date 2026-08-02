import {
  type AdapterContext,
  type BlockReason,
  PET_EVENT_VERSION,
  type PetAdapter,
  type PetEvent,
  type PetEventBody,
} from "@agent-pet/protocol";
import { classifyTool, describeTool } from "./tools.ts";

export const ADAPTER_ID = "claude-code";

/** Shape of the hook payloads we consume. Every field is treated as untrusted. */
interface RawHook {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  is_error?: unknown;
  is_interrupt?: unknown;
  notification_type?: unknown;
  agent_type?: unknown;
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

    case "PreToolUse": {
      const label = describeTool(raw.tool_name, raw.tool_input);
      return [{ type: "TOOL_START", tool, ...(label ? { label } : {}) }];
    }
    case "PostToolUse":
      // Spike B: `is_error` is documented but was never present in any recorded
      // payload — real failures arrive as `PostToolUseFailure` instead. Kept as
      // a defensive read so a future schema that does set it still works, and
      // pinned by a drift test in fixtures.test.ts.
      return [{ type: "TOOL_DONE", ok: raw.is_error !== true, tool }];
    case "PostToolUseFailure":
      // Spike B: the payload carries `is_interrupt`, which separates "the user
      // pressed ctrl-c" from "the tool broke". Both are failures for the agent;
      // only one should make the pet fall over.
      return [{ type: "TOOL_DONE", ok: false, tool, interrupted: raw.is_interrupt === true }];

    /**
     * Compaction, both ends of it. One of the longest visible pauses a session
     * has, and until M5 the pet spent it looking like it had hung.
     *
     * `PostCompact` matters as much as `PreCompact`: without it the state has
     * no authoritative end and unwinds on a five-minute decay timer, which is a
     * guess dressed as a fact.
     */
    case "PreCompact":
      return [{ type: "COMPACTING" }];
    case "PostCompact":
      return [{ type: "COMPACTED" }];

    /**
     * A delegated agent, both ends.
     *
     * `SubagentStart` carries `agent_type`, which is a better signal than
     * inferring a delegation from a tool name — and it is what makes
     * `SUBAGENT_START` mean something after sitting unused in the wire format
     * since M0.
     */
    case "SubagentStart":
      return [
        {
          type: "SUBAGENT_START",
          ...(typeof raw.agent_type === "string" ? { agentType: raw.agent_type } : {}),
        },
      ];
    case "SubagentStop":
      return [{ type: "SUBAGENT_END" }];

    /**
     * An MCP server asking the user something. Same claim on their attention as
     * a permission prompt, and it was being dropped.
     */
    case "Elicitation":
      return [{ type: "INPUT_NEEDED" }];
    case "ElicitationResult":
      // Not a state of its own: the agent goes back to whatever it was doing,
      // and the next event says what that is.
      return [{ type: "AGENT_IDLE" }];

    /**
     * Deliberately ignored, and this was a real bug for five milestones.
     *
     * `PermissionRequest` fires when the permission system *evaluates* a tool —
     * including every call a rule auto-approves. Mapping it to
     * `APPROVAL_NEEDED` meant the pet asked "May I?" for every bash command in
     * a normal session, and because it arrives *after* `PreToolUse`, the pet
     * parked in `waiting_approval` and the working states were never visible at
     * all. Observed live: an entire session in which the pet reached exactly
     * three states — asleep, digging, and asking.
     *
     * Nothing in the payload distinguishes "auto-allowed" from "asking the
     * user": `permission_mode` is the session's mode, and
     * `permission_suggestions` is present either way. So this event cannot
     * carry the meaning on its own.
     *
     * The signal that actually means a human is being asked is
     * `Notification` / `permission_prompt`, below — and it is the one that was
     * already right.
     */
    case "PermissionRequest":
      return [];
    case "PermissionDenied":
      return [{ type: "APPROVAL_RESOLVED", granted: false }];

    case "Notification":
      switch (raw.notification_type) {
        case "permission_prompt":
          return [{ type: "APPROVAL_NEEDED" }];
        case "idle_prompt":
          return [{ type: "AGENT_IDLE" }];
        // Was folded into AGENT_IDLE, which made "the agent asked you
        // something" look exactly like "the agent has nothing to do".
        case "agent_needs_input":
          return [{ type: "INPUT_NEEDED" }];
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

  hookConfig(endpoint: string): string {
    const target = { type: "http", url: endpoint, timeout: 2 };
    const plain = [{ hooks: [target] }];
    const matched = [{ matcher: ".*", hooks: [target] }];
    return JSON.stringify(
      {
        hooks: {
          SessionStart: plain,
          SessionEnd: plain,
          UserPromptSubmit: plain,
          PreToolUse: matched,
          PostToolUse: matched,
          PostToolUseFailure: matched,
          PermissionRequest: matched,
          PermissionDenied: matched,
          Notification: plain,
          Stop: plain,
          StopFailure: plain,
          PreCompact: plain,
          PostCompact: plain,
          SubagentStart: matched,
          SubagentStop: matched,
          Elicitation: matched,
          ElicitationResult: matched,
        },
      },
      null,
      2,
    );
  },

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
