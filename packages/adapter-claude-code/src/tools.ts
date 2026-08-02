import type { ToolKind } from "@agent-pet/protocol";

/**
 * The only place tool names appear anywhere in the project.
 *
 * Spec §5.3 — hooks register the broadest matcher and classification happens
 * here, in testable code, rather than as regexes scattered through a JSON
 * config where they would double-fire and could not be covered by tests.
 */
const EXACT: Readonly<Record<string, ToolKind>> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",

  Edit: "file_edit",
  Write: "file_edit",
  MultiEdit: "file_edit",
  NotebookEdit: "file_edit",

  Read: "file_read",

  // Searching, not reading. `search` had been in `ToolKind` since M0 with
  // nothing mapped to it, so the pet said "Reading TODO" for a grep — and the
  // one row in the atlas that suits rummaging around went unused.
  Glob: "search",
  Grep: "search",

  WebFetch: "network",
  WebSearch: "network",

  Task: "delegate",
  Agent: "delegate",
};

/**
 * Unknown tools fall through to "other". Agents grow new tools constantly and
 * the pet must never break when they do.
 */
export function classifyTool(toolName: unknown): ToolKind {
  if (typeof toolName !== "string" || toolName.length === 0) return "other";
  const exact = EXACT[toolName];
  if (exact) return exact;
  if (toolName.startsWith("mcp__")) return "delegate";
  return "other";
}

/**
 * A few words naming *what* the tool is doing, not just what kind it is.
 *
 * "Running" is a category; "Running pnpm test" is an answer. The bubble was
 * built on the first and reported as useless, which it was — a pet that says
 * "Working…" while you watch it work tells you nothing you did not already know
 * from the terminal next to it.
 *
 * This belongs here because this is the one file allowed to know tool names
 * (§5.3, I5). It hands `pet-core` a plain string; nothing downstream learns
 * which agent produced it, which is what I5 actually protects.
 *
 * Deliberately short and deliberately not the whole payload. The pet is an
 * always-on-top overlay that ends up in screen shares, so this leans on the
 * agent's own one-line `description` where there is one and a bare filename
 * where there is not — never a full command line, never a prompt.
 */
const MAX_LABEL = 52;

function trim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length <= MAX_LABEL ? text : `${text.slice(0, MAX_LABEL - 1)}…`;
}

function basename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return trim(value.split(/[\\/]/).filter(Boolean).at(-1));
}

function host(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return trim(new URL(value).host);
  } catch {
    return trim(value);
  }
}

/**
 * The command, minus the plumbing.
 *
 * Real commands are `cd x && pnpm test` or `export A=1; cargo build`; the last
 * segment is the one that does the work. Beyond that the command is shown as
 * written, because every attempt to be clever about it threw away the useful
 * part: reducing to the program name turned `grep -rn MAX_SCALE src/` into
 * "grep", which answers nothing, and taking the agent's `description` instead
 * produced "Running list the docs directory".
 *
 * Truncated, not summarised. A 52-character prefix of a command is recognisable
 * to the person who is running it, which is the only person looking — and it
 * keeps a full command line, with its paths and hosts, off an always-on-top
 * window that ends up in screen shares.
 */
function commandName(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const segments = command
    .split(/&&|\|\||;/)
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => !/^(cd|export|source|set)\s|^[A-Z_]+=/.test(c));

  // The first *line* of the last segment. Splitting on newlines too made a
  // heredoc report its terminator: `python3 - <<'PY' … PY` came out as "PY",
  // because the last line of a multi-line command is the least interesting
  // thing in it.
  const last = (segments.at(-1) ?? command).split("\n")[0] ?? "";
  // Flags are noise competing for a narrow bubble: `grep -n -B3 -A22 "def x"`
  // spends most of its width saying nothing, and truncation then eats the
  // pattern — the one part worth reading. Dropping them keeps the program and
  // its arguments, which is what makes a command recognisable.
  const meaningful = last
    .split(/\s+/)
    .filter((w, i) => i === 0 || !w.startsWith("-"))
    .join(" ");
  return trim(meaningful || last);
}

export function describeTool(toolName: unknown, toolInput: unknown): string | undefined {
  const input = (typeof toolInput === "object" && toolInput !== null ? toolInput : {}) as Record<
    string,
    unknown
  >;

  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      // The command, not the agent's prose about it.
      //
      // `description` was the first choice and read wrong: it describes the
      // *intent* ("List the docs directory"), which is what the verb already
      // conveys, so the bubble said "Running list the docs directory". What a
      // reader wants is which command — `pnpm verify`, `cargo test`, `grep`.
      return commandName(input.command) ?? trim(input.description);

    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return basename(input.file_path ?? input.notebook_path);

    case "Glob":
      return trim(input.pattern);
    case "Grep":
      return trim(input.pattern);

    case "WebFetch":
      return host(input.url);
    case "WebSearch":
      return trim(input.query);

    case "Task":
    case "Agent":
      return trim(input.subagent_type) ?? trim(input.description);

    default:
      // MCP tools are `mcp__server__tool`; the tool half is the useful half.
      if (typeof toolName === "string" && toolName.startsWith("mcp__")) {
        return trim(toolName.split("__").at(-1));
      }
      return trim(input.description);
  }
}
