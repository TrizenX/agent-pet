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
  error?: unknown;
  permission_suggestions?: unknown;
}

/**
 * Whether this `PermissionRequest` is a dialog on someone's screen.
 *
 * `permission_suggestions` carries the options the dialog is about to offer —
 * `setMode`, `addDirectories`, an "always allow this rule" entry. Claude Code
 * has no reason to compute them for a call it is about to wave through, and
 * measurement agrees: a prompting call arrives with two of them, an
 * auto-approved evaluation with an empty array.
 *
 * This distinction was previously recorded as impossible. The note said
 * "`permission_suggestions` is present either way, so this event cannot carry
 * the meaning on its own" — and presence *is* useless, because the key is there
 * in both cases. The content is not: it is empty in exactly the case we needed
 * to exclude. One field, examined one level deeper, instead of the timer this
 * was heading towards.
 */
function isPromptingAHuman(raw: RawHook): boolean {
  return Array.isArray(raw.permission_suggestions) && raw.permission_suggestions.length > 0;
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
     * Only when it is actually a question.
     *
     * `PermissionRequest` fires when the permission system *evaluates* a tool,
     * which under `acceptEdits` includes calls it waves straight through.
     * Mapping all of them to `APPROVAL_NEEDED` was a real bug for five
     * milestones: because this arrives *after* `PreToolUse`, the pet parked in
     * `waiting_approval` and the working states were never visible at all — one
     * observed session reached exactly three states, asleep, digging and
     * asking. Returning `[]` for everything fixed that and introduced the
     * opposite bug, which took a measured interactive session to find.
     *
     * `PermissionDenied` does not exist. It is registered, and across fifteen
     * real sessions it never fired once — not for a human pressing Esc at the
     * dialog, not for a `permissions.deny` rule. So after a refusal there is no
     * `PostToolUse` either (the tool never ran) and no `Stop`: the pet sat in
     * `working`, naming the command that had just been refused, until the 300 s
     * watchdog put it to sleep in front of a user who was sitting right there.
     * A pet asserting something false is worse than a pet saying nothing.
     *
     * `isPromptingAHuman` is what makes both bugs avoidable at once, and the
     * two committed fixture shapes are the regression test in each direction.
     * `Notification` / `permission_prompt` below stays as the other route in;
     * it does not fire for every dialog, which is why this one is needed.
     */
    case "PermissionRequest":
      return isPromptingAHuman(raw) ? [{ type: "APPROVAL_NEEDED" }] : [];
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

    /**
     * The only input to `exhausted`, and for five milestones it could not say
     * why.
     *
     * The reason was read from `error_type`, which the payload does not have.
     * The first `StopFailure` ever recorded from a real client carries:
     *
     *     "error": "authentication_failed",
     *     "last_assistant_message": "Not logged in · Please run /login"
     *
     * `authentication_failed` is a `BLOCK_REASONS` key verbatim. The table was
     * right about the vocabulary and the lookup was right about the meaning —
     * the field name was wrong, so every real block resolved to `unknown` and
     * all eight entries were unreachable. Written from documentation at M0 and
     * exercised only by payloads we wrote ourselves, which is why the tests
     * agreed with it.
     *
     * `error_type` is still read, second: if it ever appears it is the more
     * specific name and nothing here has to change again.
     */
    case "StopFailure": {
      const named = [raw.error, raw.error_type].find((v) => typeof v === "string") as
        | string
        | undefined;
      return [{ type: "AGENT_BLOCKED", reason: BLOCK_REASONS[named ?? "unknown"] ?? "unknown" }];
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
