import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** Capture only these hooks. Empty means all of them. */
  readonly only?: ReadonlySet<string>;
  /** Overwrite fixtures that already exist. Off by default. */
  readonly force?: boolean;
}

/**
 * Whether this payload should be written, and why not if not.
 *
 * Split out from the request handler because it is the part with rules, and
 * the rules exist for reasons that are easy to forget:
 *
 * `only` is what makes a capture run safe to leave running for an afternoon.
 * Twelve of the sixteen hooks already have curated fixtures; the four or five
 * that do not are the ones worth waiting for, and without a filter every
 * `PreToolUse` in the session competes for the same three slots.
 *
 * `force` guards the thing that has no undo. Fixtures are written as
 * `<Name>-<n>.json` into a directory that is usually `test/fixtures`, so a
 * default run silently overwrites files that were captured, redacted and
 * reviewed months ago — and the diff would be buried under whatever else the
 * session produced. Re-recording before a release is a stated purpose (§11.1),
 * so it stays possible; it just stops being the accident.
 */
export function shouldWrite(
  name: string,
  n: number,
  exists: boolean,
  opts: Pick<RecorderOptions, "only" | "force">,
): { write: boolean; reason?: string } {
  if (opts.only?.size && !opts.only.has(name)) {
    return { write: false, reason: "not in --only" };
  }
  if (n > MAX_PER_EVENT) return { write: false, reason: `have ${MAX_PER_EVENT}` };
  if (exists && !opts.force)
    return { write: false, reason: "already recorded, --force to replace" };
  return { write: true };
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

      const file = join(opts.outDir, `${name}-${n}.json`);
      const verdict = shouldWrite(name, n, existsSync(file), opts);
      if (!verdict.write) {
        if (opts.verbose) console.log(`[record] ${name} #${n} (skipped: ${verdict.reason})`);
        return;
      }

      const body = opts.redactPayloads ? redact(payload) : payload;
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
    // What it is waiting for, not just that it is waiting. A capture run can
    // sit for an hour and produce nothing, and "nothing happened" and "I was
    // filtering out everything" look identical from the outside.
    if (opts.only?.size) {
      console.log(`[record] waiting for: ${[...opts.only].sort().join(", ")}`);
      console.log("[record] everything else is answered 204 and dropped");
    }
    if (!opts.force) console.log("[record] existing fixtures are kept (--force to replace)");
    console.log("\nRun an agent session, then stop with ctrl-c.\n");
  });

  return { close: () => server.close() };
}
