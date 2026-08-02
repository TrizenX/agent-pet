import { invoke } from "@tauri-apps/api/core";
import { ADAPTERS } from "./registry.ts";

/**
 * The hook configuration a user needs to connect their agents.
 *
 * Lives beside the registry because composing it needs to know what an agent's
 * hooks look like, and I5 says the shell may not. The Rust side writes the
 * clipboard; it never composes the text.
 *
 * ## Why this is a document and not a payload
 *
 * It used to join every adapter's block with a blank line, on the unexamined
 * assumption that there would only ever be one. Adding the git adapter produced
 * a JSON object glued to a shell script — two things that go to different
 * places, concatenated into something that can be pasted nowhere.
 *
 * With one adapter the clipboard is still exactly its block, unchanged, because
 * that is what §5.4 promises and what anyone running a single agent wants. With
 * more than one there is no single thing to paste, so the clipboard becomes
 * what it honestly is: a short document with a heading per agent.
 *
 * The better answer is a tray submenu, one entry per adapter. That needs the
 * shell to learn which adapters exist — which it already receives through
 * `report_ready` and could rebuild the menu from, the way it rebuilds nothing
 * else today. Recorded in `artifacts/m6/FINDINGS.md` rather than built here.
 */
export async function copyHookConfig(): Promise<void> {
  const url = await invoke<string>("endpoint_url");
  // /pet-event -> the per-source route the adapters actually receive on.
  const base = url.replace(/\/pet-event$/, "/event");

  const blocks = ADAPTERS.map((adapter) => ({
    label: adapter.label,
    text: adapter.hookConfig?.(`${base}/${adapter.id}`),
  })).filter((b): b is { label: string; text: string } => typeof b.text === "string");

  if (blocks.length === 0) return;

  const text =
    blocks.length === 1
      ? (blocks[0] as { text: string }).text
      : blocks
          .map(
            (b) => `# ── ${b.label} ${"─".repeat(Math.max(0, 56 - b.label.length))}\n\n${b.text}`,
          )
          .join("\n\n");

  await invoke("copy_text", { text }).catch((e) => {
    console.error(`[hooks] copy failed: ${e instanceof Error ? e.message : e}`);
  });
}
