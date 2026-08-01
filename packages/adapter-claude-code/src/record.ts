import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * `pet-adapter record` — capture real hook payloads as test fixtures.
 *
 * The mapping in `mapping.ts` was written against documentation. Documentation
 * drifts; payloads recorded from a live agent do not. This is the only real
 * defence against a hook schema that keeps moving (spec §11.1), and it is meant
 * to be re-run before every release.
 *
 * The server does exactly what the real one must do: read the body, answer
 * `204` with an empty body, and never influence the agent (I1).
 */

const MAX_BODY = 1024 * 1024;
const MAX_PER_EVENT = 3;

/**
 * Fixtures are committed to a public repository, and raw payloads carry
 * absolute paths, prompt text, tool inputs and transcript locations. Redaction
 * is therefore not optional.
 *
 * Keys are preserved so the fixture still proves the schema; only free-text
 * values are replaced. These fields are the ones `mapping.ts` actually reads,
 * plus the enums that make a fixture readable, so their values survive intact.
 */
const KEEP_VALUES = new Set([
  "hook_event_name",
  "tool_name",
  "notification_type",
  "error_type",
  "stop_reason",
  "permission_mode",
  "source",
  "reason",
  "is_error",
  "trigger",
  "agent_type",
  "hook_event_id",
]);

const PLACEHOLDERS: Record<string, string> = {
  session_id: "session-0000",
  cwd: "/home/user/demo-project",
  transcript_path: "/home/user/.agent/transcript.jsonl",
  prompt_id: "prompt-0000",
  tool_use_id: "toolu_0000",
  agent_id: "agent-0000",
};

function redact(value: unknown, key?: string): unknown {
  if (key && key in PLACEHOLDERS) return PLACEHOLDERS[key];
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]),
    );
  }
  if (typeof value === "string") {
    if (key && KEEP_VALUES.has(key)) return value;
    // Keep the type and the length; drop the content.
    return `<redacted:string:${value.length}>`;
  }
  return value;
}

interface RecorderOptions {
  readonly port: number;
  readonly outDir: string;
  readonly redactPayloads: boolean;
  readonly verbose: boolean;
}

export function startRecorder(opts: RecorderOptions): { close: () => void } {
  mkdirSync(opts.outDir, { recursive: true });
  const counts = new Map<string, number>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => {
      // I1: respond first, with an empty body, always. A hook response body can
      // block a tool call — recording must never be able to do that.
      res.writeHead(204).end();
      if (aborted) return;

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (opts.verbose) console.error("[record] unparseable body, ignored");
        return;
      }

      const event = (payload as { hook_event_name?: unknown })?.hook_event_name ?? "Unknown";
      const name = typeof event === "string" ? event : "Unknown";
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      if (n > MAX_PER_EVENT) {
        if (opts.verbose) console.log(`[record] ${name} #${n} (skipped, have ${MAX_PER_EVENT})`);
        return;
      }

      const body = opts.redactPayloads ? redact(payload) : payload;
      const file = join(opts.outDir, `${name}-${n}.json`);
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
      console.log(`[record] ${name} #${n} -> ${file}`);
    });
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`[record] listening on http://127.0.0.1:${opts.port}`);
    console.log(`[record] writing to ${opts.outDir}`);
    console.log(
      opts.redactPayloads
        ? "[record] redaction ON — keys preserved, free-text values replaced"
        : "[record] redaction OFF — do not commit these files",
    );
    console.log("\nRun an agent session, then stop with ctrl-c.\n");
  });

  return { close: () => server.close() };
}

export function hooksBlock(port: number): unknown {
  const target = { type: "http", url: `http://127.0.0.1:${port}/event/claude-code`, timeout: 2 };
  const plain = (): unknown => ({ hooks: [target] });
  const matched = (): unknown => ({ matcher: ".*", hooks: [target] });
  return {
    SessionStart: [plain()],
    SessionEnd: [plain()],
    UserPromptSubmit: [plain()],
    PreToolUse: [matched()],
    PostToolUse: [matched()],
    PostToolUseFailure: [matched()],
    PermissionRequest: [matched()],
    PermissionDenied: [matched()],
    Notification: [plain()],
    Stop: [plain()],
    StopFailure: [plain()],
  };
}
