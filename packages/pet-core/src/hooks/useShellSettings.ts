import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { stopListening } from "../events.ts";

/**
 * Settings the tray owns.
 *
 * The shell is the source of truth because it is the only surface that still
 * works when the pet does not: a click-through pet cannot be clicked and a
 * hidden one cannot be seen, so the way back has to live outside the window.
 *
 * Field names are the Rust struct's, unconverted — this is a mirror of a file
 * on disk, not an API worth renaming across.
 */
export interface ShellSettings {
  readonly click_through: boolean;
  readonly glyphs_enabled: boolean;
  readonly scale: number;
  readonly hidden: boolean;
  /** Pack id, or empty for the built-in pet. */
  readonly pack: string;
  /** Whether the pet paces while the agent works. */
  readonly wander: boolean;
  /** "en", "vi", or empty to follow the system. */
  readonly locale: string;
}

const DEFAULTS: ShellSettings = {
  click_through: false,
  glyphs_enabled: true,
  scale: 1,
  hidden: false,
  pack: "",
  wander: true,
  locale: "",
};

/**
 * Ask the shell to wear a different pack.
 *
 * Not `setState` here: the shell persists the choice and the tray writes the
 * same field, so the frontend asks rather than decides. The answer arrives back
 * through `pet-settings`, the same path a tray click takes.
 */
export async function selectPack(slug: string): Promise<void> {
  try {
    await invoke("select_pack", { slug });
  } catch (e) {
    console.warn(`[packs] could not select ${slug}: ${e instanceof Error ? e.message : e}`);
  }
}

export function useShellSettings(): ShellSettings {
  const [settings, setSettings] = useState<ShellSettings>(DEFAULTS);

  useEffect(() => {
    // Ask once, then listen. Listening alone is not enough: `pet-settings`
    // fires only when the tray changes something, so a restart would render at
    // these defaults and silently discard a scale and glyph preference the
    // shell had already loaded from disk.
    let live = true;
    void invoke<ShellSettings>("get_settings")
      .then((s) => {
        if (live) setSettings({ ...DEFAULTS, ...s });
      })
      .catch((e) => {
        // Swallowing this hid an unregistered command for two milestones: the
        // saved scale and glyph preference silently never arrived and the app
        // looked merely under-featured. Outside the shell it is expected, so
        // it warns rather than throws — but it does say something.
        console.warn(`[settings] get_settings failed: ${e instanceof Error ? e.message : e}`);
      });

    const unlisten = listen<ShellSettings>("pet-settings", (e) =>
      setSettings({ ...DEFAULTS, ...e.payload }),
    );
    return () => {
      live = false;
      stopListening(unlisten, "pet-settings");
    };
  }, []);

  return settings;
}
