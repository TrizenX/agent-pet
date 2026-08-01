import { useEffect, useState } from "react";
import { Pet } from "./components/Pet.tsx";
import { SessionBadge } from "./components/SessionBadge.tsx";
import { SpeechBubble } from "./components/SpeechBubble.tsx";
import { StateGlyph } from "./components/StateGlyph.tsx";
import { useAgentEvents } from "./hooks/useAgentEvents.ts";
import { loadDefaultPack } from "./packs/defaultPack.ts";
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
  const { snapshot } = useAgentEvents();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    let live = true;
    void loadDefaultPack().then((p) => {
      if (live) setPack(p);
    });
    return () => {
      live = false;
    };
  }, []);

  const state = snapshot.focused?.state ?? "sleeping";

  // Surfaced through the console bridge so the rendered state is observable
  // from outside the window. An overlay has nowhere to show what it thinks it
  // is doing, and "the pet looks wrong" is not a debuggable report.
  // Declared before the early return below: hooks cannot sit behind a branch.
  useEffect(() => {
    console.log(`[pet] ${state}${snapshot.label ? ` (${snapshot.label})` : ""}`);
  }, [state, snapshot.label]);

  // Nothing is drawn until the sheet is decoded. A transparent window showing
  // nothing is the correct intermediate state for an overlay — a spinner would
  // be more visible than the pet it is standing in for.
  if (!pack) return null;

  return (
    <div className="pet-root" data-tauri-drag-region>
      <SpeechBubble state={state} project={snapshot.label} />
      <SessionBadge count={snapshot.liveCount} />
      <StateGlyph state={state} enabled reducedMotion={reducedMotion} />
      <Pet pack={pack} state={state} scale={1} reducedMotion={reducedMotion} />
    </div>
  );
}
