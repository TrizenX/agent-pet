import { invoke } from "@tauri-apps/api/core";
import { ADAPTERS } from "./registry.ts";

/**
 * The hook configuration a user pastes into their agent's settings.
 *
 * Lives beside the registry because composing it needs to know what an agent's
 * hooks look like, and I5 says the shell may not. The Rust side writes the
 * clipboard; it never composes the text.
 */
export async function copyHookConfig(): Promise<void> {
  const url = await invoke<string>("endpoint_url");
  // /pet-event -> the per-source route the adapters actually receive on.
  const base = url.replace(/\/pet-event$/, "/event");

  const blocks = ADAPTERS.map((adapter) => adapter.hookConfig?.(`${base}/${adapter.id}`)).filter(
    (b): b is string => typeof b === "string",
  );
  if (blocks.length === 0) return;

  await invoke("copy_text", { text: blocks.join("\n\n") });
}
