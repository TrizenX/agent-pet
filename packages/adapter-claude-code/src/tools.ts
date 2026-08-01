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
  Glob: "file_read",
  Grep: "file_read",

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
