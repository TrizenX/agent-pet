import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

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
}

const DEFAULTS: ShellSettings = {
  click_through: false,
  glyphs_enabled: true,
  scale: 1,
  hidden: false,
};

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
      .catch(() => {
        // Running outside the shell, e.g. `vite` on its own.
      });

    const unlisten = listen<ShellSettings>("pet-settings", (e) =>
      setSettings({ ...DEFAULTS, ...e.payload }),
    );
    return () => {
      live = false;
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  return settings;
}
