import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { copyHookConfig } from "./adapters/hookConfig.ts";
import { EventLog } from "./components/EventLog.tsx";
import { PackPicker } from "./components/PackPicker.tsx";
import { Pet } from "./components/Pet.tsx";
import { SessionBadge } from "./components/SessionBadge.tsx";
import { SpeechBubble } from "./components/SpeechBubble.tsx";
import { StateGlyph } from "./components/StateGlyph.tsx";
import { listenForScenarios } from "./demo/runner.ts";
import { stopListening } from "./events.ts";
import { useAgentEvents } from "./hooks/useAgentEvents.ts";
import { selectPack, useShellSettings } from "./hooks/useShellSettings.ts";
import { loadDefaultPack } from "./packs/defaultPack.ts";
import { loadInstalledPacks } from "./packs/discovery.ts";
import type { LoadedPack } from "./packs/loader.ts";

/**
 * The whole pet.
 *
 * Four layers, and only the first belongs to the pack: the sprite, the state
 * glyph, a word, and a session count. Everything above the sprite is ours,
 * because a pack cannot be trusted to make state legible (Spike D · F5).
 */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function App() {
  const [pack, setPack] = useState<LoadedPack | null>(null);
  const { snapshot, log } = useAgentEvents();
  const [logOpen, setLogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const shell = useShellSettings();

  useEffect(() => listenForScenarios(), []);

  useEffect(() => {
    const unlisten = listen("copy-hooks", () => void copyHookConfig());
    return () => {
      stopListening(unlisten, "copy-hooks");
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("toggle-event-log", () => setLogOpen((v) => !v));
    return () => {
      stopListening(unlisten, "toggle-event-log");
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("open-gallery", () => setPickerOpen(true));
    return () => {
      stopListening(unlisten, "open-gallery");
    };
  }, []);

  const [installed, setInstalled] = useState<readonly LoadedPack[]>([]);

  // Re-read the disk. Called at mount, and again after an install so a pack the
  // user just downloaded is usable now rather than after a restart.
  const rescanPacks = useCallback(async (live: () => boolean) => {
    const { packs, rejected } = await loadInstalledPacks();
    if (!live()) return;
    setInstalled(packs);
    // A broken pack costs a log line, not the pet (I4). Named, so the user can
    // tell which of their packs is the problem.
    console.log(`[packs] ${packs.length} loaded, ${rejected.length} skipped`);
    for (const r of rejected) console.warn(`[packs] skipped ${r.id}: ${r.reason}`);
  }, []);

  useEffect(() => {
    let live = true;
    void loadDefaultPack().then((p) => {
      if (live) setPack(p);
    });
    void rescanPacks(() => live);
    return () => {
      live = false;
    };
  }, [rescanPacks]);

  const state = snapshot.focused?.state ?? "sleeping";

  // Surfaced through the console bridge so the rendered state is observable
  // from outside the window. An overlay has nowhere to show what it thinks it
  // is doing, and "the pet looks wrong" is not a debuggable report.
  // Declared before the early return below: hooks cannot sit behind a branch.
  useEffect(() => {
    console.log(`[pet] ${state}${snapshot.label ? ` (${snapshot.label})` : ""}`);
  }, [state, snapshot.label]);

  // The tray can persist a pack the frontend cannot find, and the fallback to
  // the built-in pet looks identical to never having chosen one. Saying so
  // turns "my pet did not change" into something a user can report — it is how
  // the directory-name/manifest-id mismatch stayed invisible.
  useEffect(() => {
    if (!installed.length) return;
    if (!shell.pack) return;
    const found = installed.some((p) => p.id === shell.pack);
    if (found) console.log(`[packs] showing "${shell.pack}"`);
    else
      console.warn(
        `[packs] selected pack "${shell.pack}" is not among the ${installed.length} loaded; showing the built-in pet`,
      );
  }, [shell.pack, installed]);

  // Nothing is drawn until the sheet is decoded. A transparent window showing
  // nothing is the correct intermediate state for an overlay — a spinner would
  // be more visible than the pet it is standing in for.
  if (!pack) return null;

  // The tray's choice, falling back to the built-in pet if that pack has since
  // been uninstalled or turned out to be unreadable.
  const active = installed.find((p) => p.id === shell.pack) ?? pack;

  return (
    <div className="pet-root" data-tauri-drag-region>
      <SpeechBubble state={state} project={snapshot.label} />
      <SessionBadge count={snapshot.liveCount} />
      <StateGlyph state={state} enabled={shell.glyphs_enabled} reducedMotion={reducedMotion} />
      <Pet pack={active} state={state} scale={shell.scale} reducedMotion={reducedMotion} />
      <EventLog entries={log} open={logOpen} onClose={() => setLogOpen(false)} />
      <PackPicker
        open={pickerOpen}
        installedIds={installed.map((p) => p.id)}
        onClose={() => setPickerOpen(false)}
        onInstalled={(slug) => {
          // Load it, then wear it. Installing a pet you then have to go and
          // select is two steps where the user asked for one.
          //
          // Guarded even though `rescanPacks` cannot currently reject: the
          // failure it would produce — the picker says "installed" and the pet
          // never changes — is the exact silent-success shape this project has
          // now shipped twice.
          void rescanPacks(() => true)
            .then(() => selectPack(slug))
            .catch((e) => {
              console.warn(
                `[packs] installed ${slug} but could not apply it: ${e instanceof Error ? e.message : e}`,
              );
            });
        }}
      />
    </div>
  );
}
