import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useReducer, useRef } from "react";
import { ADAPTERS } from "../adapters/registry.ts";
import { type AgentRaw, ingestInto } from "../pipeline.ts";
import { type RegistrySnapshot, SessionRegistry } from "../sessions/registry.ts";

/**
 * Subscribes to the shell, feeds the pipeline, and re-renders on change.
 *
 * The shell forwards raw payloads and nothing else — no parsing, no
 * interpretation (I2). Everything that costs time happens here, on the far
 * side of the queue, where the agent is not waiting for it.
 */

/**
 * How often the registry is ticked.
 *
 * Once every 30 s: fast enough that a wedged state clears within a rounding
 * error of the five-minute watchdog, slow enough to stay inside I6. The shell's
 * 250 ms drain loop is the only other periodic work in the app; the two were
 * measured together at 0.116 % of one core with the pet asleep.
 */
const TICK_MS = 30_000;

/** Last N events, in memory only — payloads carry paths and prompt text (§10). */
const LOG_LIMIT = 200;

export interface LogEntry {
  readonly at: number;
  readonly source: string;
  readonly summary: string;
}

export interface AgentEventsState {
  readonly snapshot: RegistrySnapshot;
  readonly log: readonly LogEntry[];
}

export function useAgentEvents(): AgentEventsState {
  const registry = useRef<SessionRegistry>(undefined);
  registry.current ??= new SessionRegistry();

  const log = useRef<LogEntry[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const reg = registry.current;
    if (!reg) return;

    const record = (entry: LogEntry) => {
      log.current = [...log.current.slice(-(LOG_LIMIT - 1)), entry];
    };

    // Lets /health answer for the whole app while the shell stays ignorant of
    // which agents exist (I5).
    //
    // Re-reported whenever the count changes, not just once at mount. Reporting
    // only at mount pinned `sessions` at 0 forever — the M2 invariant suite
    // caught it by asking /health a question the app could not answer honestly.
    let lastReported = -1;
    const report = () => {
      if (reg.size === lastReported) return;
      lastReported = reg.size;
      void invoke("report_ready", {
        adapters: ADAPTERS.map((a) => a.id),
        sessions: reg.size,
      }).catch(() => {
        /* running outside the shell, e.g. `vite` on its own */
      });
    };
    report();

    const handle = (raw: AgentRaw) => {
      const result = ingestInto(reg, raw);
      record({
        at: raw.at,
        source: raw.source,
        summary: result.dropped
          ? `dropped: ${result.dropped}`
          : result.events.map((e) => e.type).join(", "),
      });
      report();
      bump();
    };

    const unlisten = listen<AgentRaw>("agent-raw", (e) => handle(e.payload));

    const timer = setInterval(() => {
      const evicted = reg.tick(Date.now());
      if (evicted.length > 0) {
        record({ at: Date.now(), source: "registry", summary: `evicted ${evicted.join(", ")}` });
      }
      report();
      bump();
    }, TICK_MS);

    return () => {
      clearInterval(timer);
      void unlisten.then((off) => off()).catch(() => {});
      reg.clear();
    };
  }, []);

  return {
    snapshot: registry.current.snapshot(),
    log: log.current,
  };
}
