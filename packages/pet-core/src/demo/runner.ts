import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PRE_NORMALISED_SOURCE } from "../pipeline.ts";
import { beatToEvent, scenarioById } from "./scenarios.ts";

/**
 * Plays a scenario by posting to the app's own endpoint.
 *
 * Deliberately not a shortcut into the session registry: sending the events
 * over the wire means the demo exercises the guard, the queue, the drain, the
 * pipeline and the focus policy. A demo that bypassed those would prove the
 * demo works and nothing else.
 */

/** Asked for once; the shell owns the port, not us. */
let endpoint: Promise<string> | undefined;
const endpointUrl = () => (endpoint ??= invoke<string>("endpoint_url"));

async function post(body: unknown): Promise<void> {
  await fetch(await endpointUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    // The endpoint refusing us is not worth interrupting a demo over.
  });
}

export function playScenario(id: string, now: () => number = Date.now): () => void {
  const scenario = scenarioById(id);
  if (!scenario) return () => {};

  const timers: ReturnType<typeof setTimeout>[] = [];
  let delay = 0;
  for (const beat of scenario.beats) {
    delay += beat.after;
    timers.push(setTimeout(() => void post(beatToEvent(beat, now())), delay));
  }
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}

/** Subscribe to the tray's Demo submenu. Returns an unsubscribe. */
export function listenForScenarios(): () => void {
  let cancel: (() => void) | undefined;
  const unlisten = listen<string>("demo-scenario", (e) => {
    cancel?.();
    cancel = playScenario(e.payload);
  });
  return () => {
    cancel?.();
    void unlisten.then((off) => off()).catch(() => {});
  };
}

export { PRE_NORMALISED_SOURCE };
