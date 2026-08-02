import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Unregistering a shell listener, out loud.
 *
 * Six effects had the same teardown, and all six ended in `.catch(() => {})`.
 * The project's rule is that every catch says something — it exists because
 * three unregistered Tauri commands hid behind empty catches for two
 * milestones, and the app merely looked under-featured.
 *
 * Written as one helper rather than six log lines, so the next listener cannot
 * quietly reintroduce the silent version by copying its neighbour.
 */
export function stopListening(unlisten: Promise<UnlistenFn>, event: string): void {
  void unlisten
    .then((off) => off())
    .catch((e) => {
      // A teardown failure loses nothing the user can see, so this is a warning
      // rather than an error. It still gets a name: a listener that cannot be
      // removed is a listener still firing after its component is gone.
      console.warn(`[events] could not stop listening for ${event}: ${describe(e)}`);
    });
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
